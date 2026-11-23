// ============================================================
// OPT-OUT GLOBAL — Fase 7
//
// Un solo sitio para las consecuencias de una baja:
//   - cancelar todas las corridas activas del contacto;
//   - tirar toda la cola pendiente, no solo la conversación actual;
//   - marcar marketing sin tocar el servicio (131050/user_preferences).
//
// La detección de la palabra/botón vive en estado.ts; esto solo aplica
// el efecto para que webhook, 131050 y user_preferences no dupliquen
// reglas.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

export type OrigenOptOut = "keyword" | "button" | "manual" | "meta_131050" | "user_preferences";

export interface ResultadoOptOut {
  corridasCanceladas: number;
  colaCancelada: number;
}

/** Cancela corridas activas y cola pendiente de todo el contacto. */
export async function cancelarCorridasPorBaja(
  contactId: string,
): Promise<ResultadoOptOut> {
  const db = supabaseAdmin();
  let corridasCanceladas = 0;
  let colaCancelada = 0;

  try {
    const { data } = await db
      .from("flow_runs")
      .update({
        status: "cancelled",
        end_reason: "opt_out",
        ended_at: new Date().toISOString(),
        next_run_at: null,
        resume_reason: null,
      })
      .eq("contact_id", contactId)
      .eq("status", "active")
      .select("id");
    corridasCanceladas = data?.length ?? 0;
  } catch (err) {
    console.error(
      "[opt-out] no se pudieron cancelar las corridas:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const { data } = await db
      .from("outbound_message_queue")
      .update({
        status: "CANCELLED",
        cancel_reason: "opt_out",
        updated_at: new Date().toISOString(),
      })
      .eq("contact_id", contactId)
      .in("status", ["PENDING", "PROCESSING"])
      .select("id");
    colaCancelada = data?.length ?? 0;
  } catch (err) {
    console.error(
      "[opt-out] no se pudo cancelar la cola:",
      err instanceof Error ? err.message : err,
    );
  }

  return { corridasCanceladas, colaCancelada };
}

/**
 * Opt-out solo de marketing (131050 / user_preferences). No toca el
 * servicio ni marca `opted_out`: UTILITY y respuestas dentro de la
 * ventana siguen permitidas.
 */
export async function marcarOptOutMarketing(args: {
  contactId: string;
  origen: OrigenOptOut;
}): Promise<ResultadoOptOut> {
  const db = supabaseAdmin();
  const ahora = new Date().toISOString();
  try {
    await db
      .from("contacts")
      .update({
        marketing_opted_out: true,
        marketing_opt_out_at: ahora,
        marketing_opt_out_source: args.origen,
      })
      .eq("id", args.contactId);
  } catch (err) {
    console.error(
      "[opt-out] no se pudo marcar marketing:",
      err instanceof Error ? err.message : err,
    );
  }

  // Solo se cancela la cola de difusión; un UTILITY en curso no se tira.
  let colaCancelada = 0;
  try {
    const { data } = await db
      .from("outbound_message_queue")
      .update({
        status: "CANCELLED",
        cancel_reason: "marketing_opt_out",
        updated_at: ahora,
      })
      .eq("contact_id", args.contactId)
      .eq("source", "difusion")
      .in("status", ["PENDING", "PROCESSING"])
      .select("id");
    colaCancelada = data?.length ?? 0;
  } catch (err) {
    console.error(
      "[opt-out] no se pudo cancelar la cola de marketing:",
      err instanceof Error ? err.message : err,
    );
  }

  return { corridasCanceladas: 0, colaCancelada };
}

/** Re-suscripción explícita de marketing (user_preferences). */
export async function quitarOptOutMarketing(contactId: string): Promise<void> {
  try {
    await supabaseAdmin()
      .from("contacts")
      .update({
        marketing_opted_out: false,
        marketing_opt_out_at: null,
        marketing_opt_out_source: null,
      })
      .eq("id", contactId);
  } catch (err) {
    console.error(
      "[opt-out] no se pudo quitar marketing:",
      err instanceof Error ? err.message : err,
    );
  }
}
