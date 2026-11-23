// ============================================================
// SALIDA ÚNICA DE WHATSAPP — Fase 1
//
// Regla de arquitectura: TODO mensaje saliente pasa por aquí. Los
// módulos de transporte (flujos, automatizaciones, envío manual,
// difusión) ya no llaman a Meta por su cuenta: le piden a
// `enviarSaliente()` que lo haga, y esa función registra el intento
// en `outbound_message_log` pase lo que pase.
//
// Qué garantiza esta fase:
//   - Un solo camino de salida, con un solo registro por intento.
//   - Auditoría completa: qué, a quién, cuándo, por qué, desde qué
//     flujo/nodo, con qué wamid y qué respondió Meta (o por qué falló).
//   - Los errores de Meta dejan de perderse (antes un rechazo por
//     estar fuera de la ventana de 24 h no quedaba guardado).
//
// Qué NO hace todavía (fase 2): no autoriza ni bloquea, no deduplica,
// no encola y no espera. Esta fase sólo cambia *por dónde sale* y
// *qué queda registrado*.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decidirSalida } from "./politica";
import { estadoPorSaliente } from "./estado";
import { insertarEnCola } from "./cola-store";
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
  MetaApiError,
  type SendInteractiveButtonsArgs,
  type SendInteractiveListArgs,
  type SendMediaMessageArgs,
  type SendTemplateMessageArgs,
  type SendTextMessageArgs,
} from "@/lib/whatsapp/meta-api";
import { conexionBloqueaMasivo, reservarCupoCalentamiento } from "@/lib/whatsapp/warmup";
import { marcarOptOutMarketing } from "./opt-out";

/** De dónde salió el mensaje. Se usa para el panel de riesgo. */
export type OrigenSalida =
  | "flujo"
  | "automatizacion"
  | "ia"
  | "agente"
  | "manual"
  | "difusion"
  | "ventas"
  /** Avisos internos a Julián (no van a clientas). */
  | "sistema";

export type TipoSalida = "text" | "image" | "video" | "audio" | "document" | "sticker" | "buttons" | "list" | "template";

export interface ContextoSalida {
  accountId: string;
  userId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  messageRowId?: string | null;
  /** Por qué se manda, en una línea, para poder auditar después. */
  reason?: string;
  source: OrigenSalida;
  /** Conexión de WhatsApp que envía (para salud y warm-up). */
  connectionId?: string | null;
  /** MARKETING/UTILITY/AUTHENTICATION de la plantilla, si aplica. */
  templateCategory?: string | null;
  workflowId?: string | null;
  workflowNodeKey?: string | null;
  /** El evento entrante que lo provocó (wamid o id interno). */
  sourceEventId?: string | null;
  /**
   * Clave de idempotencia. Si el mismo envío se reintenta con la misma
   * clave, no se registra dos veces. La fase 2 la usa para no repetir
   * el mensaje; aquí ya se guarda.
   */
  idempotencyKey?: string | null;
}

export interface EnvioSaliente {
  tipo: TipoSalida;
  /** Contenido para el registro (texto, pie de foto o nombre del archivo). */
  contenido?: string | null;
  /** Llamada real a Meta. */
  enviar: () => Promise<{ messageId: string; response?: unknown }>;
  /**
   * Con qué argumentos se puede rehacer el envío desde la cola si falla
   * por algo temporal (5xx, 429, red). Sin esto, un fallo no se
   * reintenta: se pierde.
   */
  payloadParaCola?: Record<string, unknown>;
}

/** Hash corto y estable del contenido, para detectar duplicados. */
export function hashContenido(texto: string): string {
  let h = 0;
  for (let i = 0; i < texto.length; i += 1) {
    h = (h * 31 + texto.charCodeAt(i)) | 0;
  }
  return `${(h >>> 0).toString(36)}-${texto.length}`;
}

/**
 * Código y mensaje de error de Meta, tal como vienen en el mensaje de
 * la excepción ("Meta API error: 400 {...}"). Se guardan crudos.
 */
export function extraerErrorMeta(err: unknown): {
  code: string | null;
  message: string;
} {
  if (err instanceof MetaApiError) {
    return {
      code: err.code !== null ? String(err.code) : null,
      message: `${err.message}${err.details ? ` · ${err.details}` : ""}`.slice(0, 2000),
    };
  }
  const bruto = err instanceof Error ? err.message : String(err);
  // Meta contesta `{"error":{"message":"...","code":131047,...}}`. Se
  // intenta leer el JSON para quedarse con el código exacto; si no se
  // puede, se guarda el texto tal cual, que también sirve para auditar.
  let codigo: string | null = null;
  let mensaje = bruto;
  const desde = bruto.indexOf("{");
  if (desde >= 0) {
    try {
      const json = JSON.parse(bruto.slice(desde)) as {
        error?: { code?: number | string; message?: string };
      };
      if (json.error?.code !== undefined) codigo = String(json.error.code);
      if (json.error?.message) mensaje = json.error.message;
    } catch {
      // se queda el texto crudo
    }
  }
  return { code: codigo, message: mensaje.slice(0, 2000) };
}

/**
 * Escribe la fila de auditoría. Nunca lanza: si el registro falla, el
 * envío no puede caerse por eso.
 */
/**
 * Modo simulación (§30): la política decide, la cola registra… y no se
 * manda nada a WhatsApp. Sirve para revisar qué habría salido y qué
 * regla lo permitió o lo frenó antes de encenderlo de verdad.
 */
export function esSimulacion(): boolean {
  const v = process.env.WHATSAPP_DRY_RUN;
  return v !== undefined && ["1", "true", "on", "yes"].includes(v.toLowerCase());
}

/**
 * ¿Es un fallo temporal? Se decide aquí (y no en `cola.ts`) para no
 * crear una dependencia circular entre el punto único y el worker.
 */
export function esFalloReintentable(mensaje: string): boolean {
  // 131049 (límite de marketing por usuario) y 131050 (opt-out de
  // marketing) no se reintentan: Meta los rechazaría igual y el
  // reintento empeora la calidad del número.
  if (/\b(131049|131050)\b/.test(mensaje)) return false;
  if (/\b130429\b/.test(mensaje)) return true;
  if (mensaje.includes("Meta API error: 5") || mensaje.includes("429")) return true;
  return /fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|network|timeout/i.test(mensaje);
}

/** Error tipado de un envío frenado por la capa de seguridad. */
export class EnvioBloqueadoError extends Error {
  readonly motivo: string;
  constructor(motivo: string, detalle: string) {
    super(`Envío bloqueado por la capa de seguridad (${motivo}): ${detalle}`);
    this.name = "EnvioBloqueadoError";
    this.motivo = motivo;
  }
}

/** Se agotó el cupo diario de calentamiento de la conexión. */
export class EnvioCalentamientoError extends Error {
  readonly limite: number | null;
  readonly dia: number | null;
  readonly reintentarEn: string;
  constructor(limite: number | null, dia: number | null) {
    const manana = new Date();
    manana.setUTCHours(24, 0, 0, 0);
    super(
      `Cupo de calentamiento agotado (día ${dia ?? "?"}, límite ${limite ?? "?"}/día).`,
    );
    this.name = "EnvioCalentamientoError";
    this.limite = limite;
    this.dia = dia;
    this.reintentarEn = manana.toISOString();
  }
}

async function registrar(fila: {
  ctx: ContextoSalida;
  tipo: TipoSalida;
  contenido?: string | null;
  status:
    | "sent"
    | "failed"
    | "blocked"
    | "skipped_meta_limit"
    | "skipped_opt_out"
    | "skipped_warmup"
    | "skipped_quality";
  whatsappMessageId?: string | null;
  apiResponse?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  blockedReason?: string | null;
  dryRun?: boolean;
  latencyMs: number;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db.from("outbound_message_log").insert({
      account_id: fila.ctx.accountId,
      conversation_id: fila.ctx.conversationId ?? null,
      connection_id: fila.ctx.connectionId ?? null,
      contact_id: fila.ctx.contactId ?? null,
      message_type: fila.tipo,
      template_category: fila.ctx.templateCategory ?? null,
      content_preview: fila.contenido ? fila.contenido.slice(0, 500) : null,
      content_hash: fila.contenido ? hashContenido(fila.contenido) : null,
      reason: fila.ctx.reason ?? null,
      source: fila.ctx.source,
      workflow_id: fila.ctx.workflowId ?? null,
      workflow_node_key: fila.ctx.workflowNodeKey ?? null,
      source_event_id: fila.ctx.sourceEventId ?? null,
      idempotency_key: fila.ctx.idempotencyKey ?? null,
      status: fila.status,
      whatsapp_message_id: fila.whatsappMessageId ?? null,
      api_response: (fila.apiResponse ?? null) as never,
      error_code: fila.errorCode ?? null,
      error_message: fila.errorMessage ?? null,
      blocked_reason: fila.blockedReason ?? null,
      dry_run: fila.dryRun ?? false,
      latency_ms: Math.round(fila.latencyMs),
      created_by_user_id: fila.ctx.userId ?? null,
      sent_at: fila.status === "sent" ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.error(
      "[messaging] no se pudo registrar el envío:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * El único lugar autorizado para hablar con WhatsApp.
 *
 * Envuelve la llamada real: mide el tiempo, captura el wamid o el
 * error de Meta, deja la fila de auditoría y vuelve a lanzar el error
 * para que quien llamó lo trate como siempre. El comportamiento
 * visible no cambia; lo que cambia es que ahora queda registrado.
 */
export async function enviarSaliente(
  ctx: ContextoSalida,
  envio: EnvioSaliente,
): Promise<{ messageId: string; response?: unknown }> {
  const inicio = Date.now();

  // Fase 2: la política decide antes de tocar Meta. Si frena, queda la
  // huella en el registro (con la regla exacta) y no se envía nada.
  const decision = await decidirSalida({
    ctx,
    tipo: envio.tipo,
    contenido: envio.contenido,
    hash: envio.contenido ? hashContenido(envio.contenido) : null,
  });
  if (!decision.permitido) {
    await registrar({
      ctx,
      tipo: envio.tipo,
      contenido: envio.contenido,
      status: "blocked",
      blockedReason: decision.motivo,
      errorMessage: decision.detalle ?? null,
      latencyMs: Date.now() - inicio,
    });
    throw new EnvioBloqueadoError(decision.motivo ?? "blocked", decision.detalle ?? "");
  }
  // Modo observación: la regla habría frenado, pero el mensaje sale. Se
  // deja constancia en la MISMA fila del envío (una fila por mensaje),
  // para poder medir los topes antes de activarlos.
  const aviso = decision.motivo ? decision : null;

  // Compuertas por conexión: salud (RED/restringido) y calentamiento.
  // Solo aplican a marketing/masivos; un UTILITY o una respuesta 1:1 no
  // se bloquea por calidad del número.
  if (
    ctx.connectionId &&
    (ctx.source === "difusion" || ctx.templateCategory === "Marketing")
  ) {
    try {
      const { data: conexion } = await supabaseAdmin()
        .from("whatsapp_connections")
        .select(
          "health_status, restriction_scope, quality_rating, warmup_enabled, warmup_started_at",
        )
        .eq("id", ctx.connectionId)
        .maybeSingle();
      if (conexion) {
        const bloqueo = conexionBloqueaMasivo(
          conexion as {
            health_status?: string | null;
            restriction_scope?: string | null;
            quality_rating?: string | null;
          },
        );
        if (bloqueo.bloqueado) {
          await registrar({
            ctx,
            tipo: envio.tipo,
            contenido: envio.contenido,
            status: "blocked",
            blockedReason: "connection_health",
            errorMessage: bloqueo.motivo,
            latencyMs: Date.now() - inicio,
          });
          throw new EnvioBloqueadoError(
            "connection_health",
            bloqueo.motivo ?? "Conexión restringida por Meta.",
          );
        }

        if (ctx.source === "difusion") {
          const cupo = await reservarCupoCalentamiento(supabaseAdmin(), {
            connectionId: ctx.connectionId,
            warmupEnabled: Boolean(
              (conexion as { warmup_enabled?: boolean }).warmup_enabled,
            ),
            warmupStartedAt:
              (conexion as { warmup_started_at?: string | null })
                .warmup_started_at ?? null,
          });
          if (!cupo.permitido) {
            await registrar({
              ctx,
              tipo: envio.tipo,
              contenido: envio.contenido,
              status: "blocked",
              blockedReason: "warmup_limit",
              errorMessage: `Cupo diario de calentamiento agotado (día ${cupo.dia}, límite ${cupo.limite}).`,
              latencyMs: Date.now() - inicio,
            });
            throw new EnvioCalentamientoError(cupo.limite, cupo.dia);
          }
        }
      }
    } catch (err) {
      if (
        err instanceof EnvioBloqueadoError ||
        err instanceof EnvioCalentamientoError
      ) {
        throw err;
      }
      // Si no se pudo leer la conexión, no se frena por infraestructura;
      // la política y el propio Meta siguen siendo la última palabra.
      console.error(
        "[messaging] no se pudo verificar la conexión:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (esSimulacion()) {
    // No se llama a Meta: se registra como si hubiera salido.
    const simulado = { messageId: `dryrun.${Date.now()}`, response: null };
    await registrar({
      ctx,
      tipo: envio.tipo,
      contenido: envio.contenido,
      status: "sent",
      whatsappMessageId: simulado.messageId,
      blockedReason: aviso?.motivo ?? null,
      dryRun: true,
      latencyMs: Date.now() - inicio,
    });
    return simulado;
  }

  try {
    const r = await envio.enviar();
    await registrar({
      ctx,
      tipo: envio.tipo,
      contenido: envio.contenido,
      status: "sent",
      whatsappMessageId: r.messageId,
      apiResponse: r.response ?? null,
      blockedReason: aviso?.motivo ?? null,
      errorMessage: aviso?.detalle ?? null,
      dryRun: Boolean(aviso),
      latencyMs: Date.now() - inicio,
    });
    // Fase 3: el estado sigue a los mensajes. Un envío de una persona
    // deja la conversación en traspaso (la automatización se aparta); un
    // automático la deja esperando a la clienta.
    if (ctx.conversationId) {
      await estadoPorSaliente({
        conversationId: ctx.conversationId,
        automatico: !["manual"].includes(ctx.source),
      });
    }
    return r;
  } catch (err) {
    const { code, message } = extraerErrorMeta(err);
    const status =
      code === "131049"
        ? "skipped_meta_limit"
        : code === "131050"
          ? "skipped_opt_out"
          : "failed";
    await registrar({
      ctx,
      tipo: envio.tipo,
      contenido: envio.contenido,
      status,
      errorCode: code,
      errorMessage: message,
      latencyMs: Date.now() - inicio,
    });

    // 131050: Meta confirma que la clienta no quiere marketing. No es
    // una baja total: UTILITY y servicio siguen permitidos.
    if (code === "131050" && ctx.contactId) {
      await marcarOptOutMarketing({
        contactId: ctx.contactId,
        origen: "meta_131050",
      }).catch(() => undefined);
    }

    // Fase 4: si el fallo es temporal (5xx, 429, 130429, red) y sabemos
    // con qué argumentos rehacerlo, se encola el reintento. 131049 y
    // 131050 nunca se reintentan. La clave de idempotencia es la misma,
    // así que no puede duplicarse (§19).
    const reintentar =
      status === "failed" &&
      esFalloReintentable(`${code ?? ""} ${message}`);
    if (envio.payloadParaCola && reintentar && ctx.conversationId) {
      void insertarEnCola({
        account_id: ctx.accountId,
        conversation_id: ctx.conversationId,
        connection_id: ctx.connectionId ?? null,
        contact_id: ctx.contactId ?? null,
        message_type: envio.tipo,
        payload: envio.payloadParaCola,
        content_preview: envio.contenido ? envio.contenido.slice(0, 500) : null,
        reason: ctx.reason ?? null,
        source: ctx.source,
        template_category: ctx.templateCategory ?? null,
        workflow_id: ctx.workflowId ?? null,
        workflow_node_key: ctx.workflowNodeKey ?? null,
        source_event_id: ctx.sourceEventId ?? null,
        idempotency_key: ctx.idempotencyKey ?? null,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Envoltorios por tipo de mensaje. Los módulos de transporte usan estos y
// así no vuelven a tocar `meta-api` directamente (hay una prueba que lo
// comprueba: `salida-unica.test.ts`).
// ---------------------------------------------------------------------------

export type ArgsTexto = SendTextMessageArgs & { ctx: ContextoSalida };
export type ArgsMedios = SendMediaMessageArgs & { ctx: ContextoSalida };
export type ArgsPlantilla = SendTemplateMessageArgs & { ctx: ContextoSalida };
export type ArgsBotones = SendInteractiveButtonsArgs & { ctx: ContextoSalida };
export type ArgsLista = SendInteractiveListArgs & { ctx: ContextoSalida };

export async function enviarTexto({ ctx, ...args }: ArgsTexto) {
  return enviarSaliente(ctx, {
    tipo: "text",
    contenido: args.text,
    enviar: () => sendTextMessage(args),
    payloadParaCola: {
      text: args.text,
      ...(args.contextMessageId ? { contextMessageId: args.contextMessageId } : {}),
    },
  });
}

export async function enviarMedio({ ctx, kind, caption, filename, ...args }: ArgsMedios) {
  return enviarSaliente(ctx, {
    tipo: kind,
    contenido: caption ?? filename ?? null,
    enviar: () =>
      sendMediaMessage({
        ...args,
        kind,
        ...(caption ? { caption } : {}),
        ...(filename ? { filename } : {}),
      } as SendMediaMessageArgs),
    payloadParaCola: {
      kind,
      link: (args as { link?: string }).link ?? "",
      ...(caption ? { caption } : {}),
      ...(filename ? { filename } : {}),
      ...(args.contextMessageId ? { contextMessageId: args.contextMessageId } : {}),
    },
  });
}

export async function enviarPlantilla({ ctx, ...args }: ArgsPlantilla) {
  const ctxConCategoria: ContextoSalida = {
    ...ctx,
    templateCategory: args.template?.category ?? ctx.templateCategory ?? null,
  };
  return enviarSaliente(ctxConCategoria, {
    tipo: "template",
    contenido: args.templateName,
    enviar: () => sendTemplateMessage(args),
    payloadParaCola: {
      templateName: args.templateName,
      ...(args.language ? { language: args.language } : {}),
      ...(args.params ? { params: args.params } : {}),
      ...(args.contextMessageId ? { contextMessageId: args.contextMessageId } : {}),
    },
  });
}

export async function enviarBotones({ ctx, ...args }: ArgsBotones) {
  return enviarSaliente(ctx, {
    tipo: "buttons",
    contenido: args.bodyText,
    enviar: () => sendInteractiveButtons(args),
    payloadParaCola: {
      bodyText: args.bodyText,
      buttons: args.buttons as never,
      ...(args.contextMessageId ? { contextMessageId: args.contextMessageId } : {}),
    },
  });
}

export async function enviarLista({ ctx, ...args }: ArgsLista) {
  return enviarSaliente(ctx, {
    tipo: "list",
    contenido: args.bodyText,
    enviar: () => sendInteractiveList(args),
    payloadParaCola: {
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      sections: args.sections as never,
      ...(args.contextMessageId ? { contextMessageId: args.contextMessageId } : {}),
    },
  });
}
