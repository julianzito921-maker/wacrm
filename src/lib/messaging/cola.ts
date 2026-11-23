// ============================================================
// COLA DE SALIDA — worker (Fase 4)
//
// Un solo sitio donde esperar, reintentar y cancelar mensajes.
//
//   - `encolar()` mete una intención de envío (idempotente: la misma
//     clave no entra dos veces, §19);
//   - `reclamarLote()` pide un lote a la base, que lo entrega con
//     FOR UPDATE SKIP LOCKED: dos workers nunca toman la misma fila (§18);
//   - `procesarLote()` reintenta con espera creciente los fallos
//     temporales y da por perdido lo que no se puede recuperar;
//   - `cancelarPendientes()` tira los mensajes que ya no tienen sentido
//     cuando la clienta contesta, pide humano o se da de baja (§17).
//
// Importante: aquí NO se decide si un mensaje puede salir. De eso sigue
// encargándose la política (fases 2 y 3) a través del punto único, así
// que un reintento tampoco puede saltarse la ventana de 24 h.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { credencialesDeConexion, credencialesDeConversacion } from "@/lib/whatsapp/connections";
import { loadAccountMetaCredentials } from "@/lib/flows/meta-send";
import { resolveContactSendTarget } from "@/lib/whatsapp/wa-identity";
import { marcarFila } from "./cola-store";
import {
  enviarBotones,
  enviarLista,
  enviarMedio,
  enviarPlantilla,
  enviarTexto,
  EnvioBloqueadoError,
  EnvioCalentamientoError,
  esFalloReintentable,
  extraerErrorMeta,
  type ContextoSalida,
  type OrigenSalida,
} from "./send";
import { marcarOptOutMarketing } from "./opt-out";

export { cancelarPendientes, insertarEnCola as encolar } from "./cola-store";

/** ¿Vale la pena reintentar? Un 5xx, un 130429 o un corte de red, sí;
 *  un rechazo de Meta por política (131049/131050/4xx), no. */
export function esReintentable(err: unknown): boolean {
  const { code, message } = extraerErrorMeta(err);
  if (code === "131049" || code === "131050") return false;
  if (code === "130429") return true;
  return esFalloReintentable(`${code ?? ""} ${message}`);
}

/** Espera entre intentos. 130429 es más lento que un 5xx normal. */
export function esperaReintento(intento: number, codigo?: string | null): number {
  if (codigo === "130429") {
    const escalones = [60_000, 300_000, 900_000, 1_800_000];
    return escalones[Math.min(Math.max(intento - 1, 0), escalones.length - 1)];
  }
  const escalones = [30_000, 120_000, 600_000];
  return escalones[Math.min(Math.max(intento - 1, 0), escalones.length - 1)];
}

export interface FilaCola {
  id: string;
  account_id: string;
  conversation_id: string | null;
  connection_id: string | null;
  contact_id: string | null;
  message_type: string;
  payload: Record<string, unknown>;
  template_category: string | null;
  reason: string | null;
  source: string;
  workflow_id: string | null;
  workflow_node_key: string | null;
  source_event_id: string | null;
  idempotency_key: string | null;
  attempt_number: number;
  max_attempts: number;
}

export async function reclamarLote(limite = 20): Promise<FilaCola[]> {
  try {
    const db = supabaseAdmin();
    const { data } = await db.rpc("claim_outbound_queue", { p_limit: limite });
    return (data as FilaCola[] | null) ?? [];
  } catch (err) {
    console.error(
      "[cola] no se pudo reclamar el lote:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Rehace el envío de una fila usando el punto único (con su política). */
async function enviarFila(fila: FilaCola): Promise<{ messageId: string }> {
  const db = supabaseAdmin();
  if (!fila.contact_id || !fila.conversation_id) {
    throw new Error("fila sin contacto o conversación");
  }
  const { data: contacto } = await db
    .from("contacts")
    .select("id, phone, wa_user_id")
    .eq("id", fila.contact_id)
    .maybeSingle();
  const destino = resolveContactSendTarget(
    contacto as { phone?: string | null; wa_user_id?: string | null },
  );
  if (!destino) throw new Error("contacto sin dirección de WhatsApp");

  const creds =
    (fila.connection_id
      ? await credencialesDeConexion(db, fila.connection_id)
      : await credencialesDeConversacion(db, fila.conversation_id, fila.account_id)) ??
    (await loadAccountMetaCredentials(db, fila.account_id));
  const { phoneNumberId, accessToken } = creds;
  const ctx: ContextoSalida = {
    accountId: fila.account_id,
    conversationId: fila.conversation_id,
    connectionId: fila.connection_id,
    contactId: fila.contact_id,
    source: fila.source as OrigenSalida,
    reason: fila.reason ?? "reintento de la cola",
    templateCategory:
      fila.template_category ??
      (typeof fila.payload?.templateCategory === "string"
        ? fila.payload.templateCategory
        : null),
    workflowId: fila.workflow_id,
    workflowNodeKey: fila.workflow_node_key,
    sourceEventId: fila.source_event_id,
    idempotencyKey: fila.idempotency_key,
  };
  const p = fila.payload ?? {};
  const base = { ctx, phoneNumberId, accessToken, to: destino.target };

  switch (fila.message_type) {
    case "text":
      return enviarTexto({
        ...base,
        text: String(p.text ?? ""),
        ...(typeof p.contextMessageId === "string"
          ? { contextMessageId: p.contextMessageId }
          : {}),
      });
    case "image":
    case "video":
    case "audio":
    case "document":
      return enviarMedio({
        ...base,
        kind: fila.message_type as "image" | "video" | "audio" | "document" | "sticker",
        link: String(p.link ?? ""),
        ...(typeof p.caption === "string" ? { caption: p.caption } : {}),
        ...(typeof p.filename === "string" ? { filename: p.filename } : {}),
        ...(typeof p.contextMessageId === "string"
          ? { contextMessageId: p.contextMessageId }
          : {}),
      });
    case "template":
      return enviarPlantilla({
        ...base,
        templateName: String(p.templateName ?? ""),
        ...(typeof p.language === "string" ? { language: p.language } : {}),
        ...(Array.isArray(p.params) ? { params: p.params as string[] } : {}),
        ...(typeof p.contextMessageId === "string"
          ? { contextMessageId: p.contextMessageId }
          : {}),
      });
    case "buttons":
      return enviarBotones({
        ...base,
        bodyText: String(p.bodyText ?? ""),
        buttons: (p.buttons ?? []) as never,
        ...(typeof p.contextMessageId === "string"
          ? { contextMessageId: p.contextMessageId }
          : {}),
      });
    case "list":
      return enviarLista({
        ...base,
        bodyText: String(p.bodyText ?? ""),
        buttonLabel: String(p.buttonLabel ?? ""),
        sections: (p.sections ?? []) as never,
        ...(typeof p.contextMessageId === "string"
          ? { contextMessageId: p.contextMessageId }
          : {}),
      });
    default:
      throw new Error(`tipo no soportado en la cola: ${fila.message_type}`);
  }
}

export interface ResultadoCola {
  procesados: number;
  enviados: number;
  reprogramados: number;
  cancelados: number;
  fallidos: number;
}

/** Vacía un lote de la cola: lo llama el cron (un solo worker, §22). */
export async function procesarLote(limite = 20): Promise<ResultadoCola> {
  const res: ResultadoCola = {
    procesados: 0,
    enviados: 0,
    reprogramados: 0,
    cancelados: 0,
    fallidos: 0,
  };
  const filas = await reclamarLote(limite);
  for (const fila of filas) {
    res.procesados += 1;
    try {
      const r = await enviarFila(fila);
      await marcarFila(fila.id, {
        status: "SENT",
        sent_at: new Date().toISOString(),
        whatsapp_message_id: r.messageId,
        last_error: null,
      });
      res.enviados += 1;
    } catch (err) {
      if (err instanceof EnvioCalentamientoError) {
        // Se agotó el cupo del día: se reprograma para mañana, no se
        // pierde el mensaje ni se marca como fallo.
        await marcarFila(fila.id, {
          status: "PENDING",
          last_error: err.message.slice(0, 500),
          error_code: "WARMUP_LIMIT",
          next_retry_at: err.reintentarEn,
        });
        res.reprogramados += 1;
        continue;
      }
      if (err instanceof EnvioBloqueadoError) {
        // La política lo frenó: ya no tiene sentido reintentarlo.
        await marcarFila(fila.id, {
          status: "CANCELLED",
          cancel_reason: err.motivo,
          error_code: err.motivo,
          last_error: err.message.slice(0, 500),
        });
        res.cancelados += 1;
        continue;
      }

      const { code, message } = extraerErrorMeta(err);
      if (code === "131049") {
        await marcarFila(fila.id, {
          status: "SKIPPED_META_LIMIT",
          error_code: code,
          last_error: message.slice(0, 500),
        });
        res.cancelados += 1;
        continue;
      }
      if (code === "131050") {
        if (fila.contact_id) {
          await marcarOptOutMarketing({
            contactId: fila.contact_id,
            origen: "meta_131050",
          }).catch(() => undefined);
        }
        await marcarFila(fila.id, {
          status: "SKIPPED_OPT_OUT",
          error_code: code,
          last_error: message.slice(0, 500),
        });
        res.cancelados += 1;
        continue;
      }

      if (esReintentable(err) && fila.attempt_number < fila.max_attempts) {
        await marcarFila(fila.id, {
          status: "PENDING",
          last_error: message.slice(0, 500),
          error_code: code,
          next_retry_at: new Date(
            Date.now() + esperaReintento(fila.attempt_number, code),
          ).toISOString(),
        });
        res.reprogramados += 1;
        continue;
      }
      await marcarFila(fila.id, {
        status: "FAILED",
        last_error: message.slice(0, 500),
        error_code: code,
      });
      res.fallidos += 1;
    }
  }
  return res;
}
