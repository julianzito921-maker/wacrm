/**
 * Efectos de los errores de entrega asíncronos de Meta.
 *
 * El webhook de estados `failed` trae el código real. Aquí se decide
 * qué hacer sin volver a tocar la red:
 *   131049 → skipped_meta_limit (no reintentar; enfriamiento 24 h)
 *   131050 → marketing_opted_out (UTILITY/servicio siguen permitidos)
 *   130429 → fallo de rate limit (el reintento síncrono ya lo maneja
 *            la cola; un failed asíncrono no se reenvía solo)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { marcarOptOutMarketing } from "@/lib/messaging/opt-out";
import type { MessageStatusFailure } from "./message-status-sync";

export type AccionErrorEntrega =
  | "skip_meta_limit"
  | "marketing_opt_out"
  | "rate_limit"
  | "failed";

export function clasificarErrorEntrega(code: number | null): AccionErrorEntrega {
  if (code === 131049) return "skip_meta_limit";
  if (code === 131050) return "marketing_opt_out";
  if (code === 130429) return "rate_limit";
  return "failed";
}

function estadoLog(accion: AccionErrorEntrega): string {
  if (accion === "skip_meta_limit") return "skipped_meta_limit";
  if (accion === "marketing_opt_out") return "skipped_opt_out";
  return "failed";
}

function estadoCola(accion: AccionErrorEntrega): string {
  if (accion === "skip_meta_limit") return "SKIPPED_META_LIMIT";
  if (accion === "marketing_opt_out") return "SKIPPED_OPT_OUT";
  return "FAILED";
}

export async function aplicarFalloEntregaMeta(
  db: SupabaseClient,
  args: {
    accountId: string;
    wamid: string;
    failure: MessageStatusFailure;
  },
): Promise<void> {
  const accion = clasificarErrorEntrega(args.failure.code);
  const detalle = [args.failure.title, args.failure.details]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);

  let contactId: string | null = null;
  try {
    const { data: log } = await db
      .from("outbound_message_log")
      .select("contact_id")
      .eq("account_id", args.accountId)
      .eq("whatsapp_message_id", args.wamid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    contactId = (log as { contact_id?: string | null } | null)?.contact_id ?? null;
  } catch {
    // se intenta por broadcast_recipients más abajo
  }

  if (!contactId) {
    try {
      const { data: rec } = await db
        .from("broadcast_recipients")
        .select("contact_id")
        .eq("whatsapp_message_id", args.wamid)
        .limit(1)
        .maybeSingle();
      contactId = (rec as { contact_id?: string | null } | null)?.contact_id ?? null;
    } catch {
      // sin contacto no se puede marcar marketing; el resto sí se audita
    }
  }

  if (accion === "marketing_opt_out" && contactId) {
    await marcarOptOutMarketing({
      contactId,
      origen: "meta_131050",
    }).catch(() => undefined);
  }

  try {
    await db
      .from("outbound_message_log")
      .update({
        status: estadoLog(accion),
        error_code: String(args.failure.code),
        error_message: detalle,
      })
      .eq("account_id", args.accountId)
      .eq("whatsapp_message_id", args.wamid);
  } catch (err) {
    console.error(
      "[delivery-errors] no se pudo actualizar el log:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await db
      .from("outbound_message_queue")
      .update({
        status: estadoCola(accion),
        error_code: String(args.failure.code),
        last_error: detalle,
        updated_at: new Date().toISOString(),
      })
      .eq("account_id", args.accountId)
      .eq("whatsapp_message_id", args.wamid)
      .in("status", ["SENT", "PROCESSING", "PENDING"]);
  } catch (err) {
    console.error(
      "[delivery-errors] no se pudo actualizar la cola:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await db
      .from("broadcast_recipients")
      .update({
        status: "failed",
        error_code: String(args.failure.code),
        error_message: detalle,
      })
      .eq("whatsapp_message_id", args.wamid);
  } catch (err) {
    console.error(
      "[delivery-errors] no se pudo actualizar el destinatario:",
      err instanceof Error ? err.message : err,
    );
  }
}
