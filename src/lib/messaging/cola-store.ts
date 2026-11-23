// ============================================================
// COLA DE SALIDA — acceso a datos
//
// Se separa del worker (`cola.ts`) a propósito: el punto único de envío
// (`send.ts`) necesita ENCOLAR un reintento, y el worker necesita ENVIAR.
// Si ambos se importaran entre sí habría un ciclo; con esta pieza las
// dependencias van en una sola dirección:
//
//   send.ts ──► cola-store.ts ◄── cola.ts ──► send.ts
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

export interface FilaParaEncolar {
  account_id: string;
  conversation_id: string | null;
  connection_id?: string | null;
  contact_id: string | null;
  message_type: string;
  payload: Record<string, unknown>;
  content_preview?: string | null;
  reason?: string | null;
  source: string;
  template_category?: string | null;
  workflow_id?: string | null;
  workflow_node_key?: string | null;
  source_event_id?: string | null;
  idempotency_key?: string | null;
  scheduled_at?: string | null;
  priority?: number;
  max_attempts?: number;
}

/** Encola (idempotente por `account_id + idempotency_key`). */
export async function insertarEnCola(fila: FilaParaEncolar): Promise<string | null> {
  try {
    const db = supabaseAdmin();
    let connectionId = fila.connection_id ?? null;
    if (!connectionId && fila.conversation_id) {
      const { data: conv } = await db
        .from("conversations")
        .select("connection_id")
        .eq("id", fila.conversation_id)
        .maybeSingle();
      connectionId = (conv?.connection_id as string | null) ?? null;
    }
    const { data } = await db
      .from("outbound_message_queue")
      .upsert({ ...fila, connection_id: connectionId } as never, {
        onConflict: "account_id,idempotency_key",
        ignoreDuplicates: true,
      })
      .select("id");
    return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
  } catch (err) {
    console.error(
      "[cola] no se pudo encolar:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function marcarFila(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("outbound_message_queue")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
  } catch (err) {
    console.error(
      "[cola] no se pudo actualizar la fila:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Cancela lo que ya no tiene sentido mandar (§17). */
export async function cancelarPendientes(
  conversationId: string,
  motivo: string,
): Promise<number> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("outbound_message_queue")
      .update({
        status: "CANCELLED",
        cancel_reason: motivo,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversationId)
      .eq("status", "PENDING")
      .select("id");
    return (data as unknown[] | null)?.length ?? 0;
  } catch {
    return 0;
  }
}
