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
  type SendInteractiveButtonsArgs,
  type SendInteractiveListArgs,
  type SendMediaMessageArgs,
  type SendTemplateMessageArgs,
  type SendTextMessageArgs,
} from "@/lib/whatsapp/meta-api";

/** De dónde salió el mensaje. Se usa para el panel de riesgo. */
export type OrigenSalida =
  | "flujo"
  | "automatizacion"
  | "ia"
  | "manual"
  | "difusion"
  | "ventas";

export type TipoSalida = "text" | "image" | "video" | "audio" | "document" | "buttons" | "list" | "template";

export interface ContextoSalida {
  accountId: string;
  userId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  messageRowId?: string | null;
  /** Por qué se manda, en una línea, para poder auditar después. */
  reason?: string;
  source: OrigenSalida;
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
 * ¿Es un fallo temporal? Se decide aquí (y no en `cola.ts`) para no
 * crear una dependencia circular entre el punto único y el worker.
 */
export function esFalloReintentable(mensaje: string): boolean {
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

async function registrar(fila: {
  ctx: ContextoSalida;
  tipo: TipoSalida;
  contenido?: string | null;
  status: "sent" | "failed" | "blocked";
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
      contact_id: fila.ctx.contactId ?? null,
      message_row_id: fila.ctx.messageRowId ?? null,
      message_type: fila.tipo,
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
    await registrar({
      ctx,
      tipo: envio.tipo,
      contenido: envio.contenido,
      status: "failed",
      errorCode: code,
      errorMessage: message,
      latencyMs: Date.now() - inicio,
    });

    // Fase 4: si el fallo es temporal (5xx, 429, red) y sabemos con qué
    // argumentos rehacerlo, se encola el reintento. La clave de
    // idempotencia es la misma, así que no puede duplicarse (§19).
    if (envio.payloadParaCola && esFalloReintentable(message) && ctx.conversationId) {
      void insertarEnCola({
        account_id: ctx.accountId,
        conversation_id: ctx.conversationId,
        contact_id: ctx.contactId ?? null,
        message_type: envio.tipo,
        payload: envio.payloadParaCola,
        content_preview: envio.contenido ? envio.contenido.slice(0, 500) : null,
        reason: ctx.reason ?? null,
        source: ctx.source,
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
    payloadParaCola: { text: args.text },
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
    },
  });
}

export async function enviarPlantilla({ ctx, ...args }: ArgsPlantilla) {
  return enviarSaliente(ctx, {
    tipo: "template",
    contenido: args.templateName,
    enviar: () => sendTemplateMessage(args),
    payloadParaCola: {
      templateName: args.templateName,
      ...(args.language ? { language: args.language } : {}),
      ...(args.params ? { params: args.params } : {}),
    },
  });
}

export async function enviarBotones({ ctx, ...args }: ArgsBotones) {
  return enviarSaliente(ctx, {
    tipo: "buttons",
    contenido: args.bodyText,
    enviar: () => sendInteractiveButtons(args),
    payloadParaCola: { bodyText: args.bodyText, buttons: args.buttons as never },
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
    },
  });
}
