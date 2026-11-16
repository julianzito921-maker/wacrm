// ============================================================
// MEMORIA DE LA CONVERSACIÓN — Fase 5
//
// «No duplicar información» (§11): el sistema tiene que saber si ya
// comunicó el precio, el contenido, los bonos, el pago o la entrega.
//
// Se deduce del registro de salida (fase 1) en vez de guardar otra
// tabla: cada envío ya dejó ahí su texto, así que se leen las últimas
// filas y se buscan los marcadores de cada tema. Es determinista, no
// cuesta modelo y no puede desincronizarse de lo que de verdad salió.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { TEMAS, temasEn, type Memoria } from "./intencion";

const VENTANA_FILAS = 80;

/**
 * Qué temas ya se comunicaron en esta conversación. Ante cualquier
 * problema de lectura devuelve vacío: mejor decir de más que quedarse
 * mudo por un fallo de base.
 */
export async function memoriaDe(conversationId: string): Promise<Memoria> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("outbound_message_log")
      .select("content_preview, workflow_node_key, status")
      .eq("conversation_id", conversationId)
      .in("status", ["sent"])
      .order("created_at", { ascending: false })
      .limit(VENTANA_FILAS);

    const memoria: Memoria = {};
    for (const fila of (data as Array<{
      content_preview: string | null;
      workflow_node_key: string | null;
    }> | null) ?? []) {
      const texto = `${fila.content_preview ?? ""} ${fila.workflow_node_key ?? ""}`;
      for (const tema of temasEn(texto)) memoria[tema] = true;
    }
    return memoria;
  } catch {
    return {};
  }
}

/** Frase corta con lo ya comunicado, para el registro y las pruebas. */
export function resumenMemoria(memoria: Memoria): string {
  const dichos = TEMAS.filter((t) => memoria[t]);
  return dichos.length ? dichos.join(", ") : "nada todavía";
}
