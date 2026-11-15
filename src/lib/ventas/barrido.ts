// Barrido de pendientes (pedido de Julián, 2026-11-12): cada 2 h busca conversaciones donde lo
// último es un mensaje de la clienta SIN respuesta (más de 10 min, dentro de las 24 h de WhatsApp)
// y hace que el agente de la cuenta le conteste con todo el contexto. Si la conversación tenía la IA
// apagada, la reactiva (el agente siempre atiende). Solo cuentas con la IA y la respuesta automática
// encendidas. Imágenes y documentos se saltan (los atiende el lector de comprobantes).
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

const MIN_ESPERA_MS = 10 * 60_000
const VENTANA_MS = 23.5 * 3_600_000   // margen antes de que se cierren las 24 h

export interface ResultadoBarrido { revisadas: number; contestadas: number; reactivadas: number; detalle: string[] }

/** ¿Este último mensaje queda pendiente de respuesta? Exportado para pruebas. */
export function quedaPendiente(ultimo: { sender_type: string; content_type: string; created_at: string } | null, ahora: number): boolean {
  if (!ultimo || ultimo.sender_type !== 'customer') return false
  if (!['text', 'interactive', 'button', 'audio'].includes(ultimo.content_type)) return false
  const edad = ahora - new Date(ultimo.created_at).getTime()
  return edad >= MIN_ESPERA_MS && edad <= VENTANA_MS
}

export async function barrerPendientes(): Promise<ResultadoBarrido> {
  const db = supabaseAdmin()
  const res: ResultadoBarrido = { revisadas: 0, contestadas: 0, reactivadas: 0, detalle: [] }
  const ahora = Date.now()
  const { data: ais } = await db.from('ai_configs').select('account_id').eq('is_active', true).eq('auto_reply_enabled', true)
  for (const { account_id: accountId } of ais ?? []) {
    const { data: cfg } = await db.from('whatsapp_config').select('user_id').eq('account_id', accountId).maybeSingle()
    if (!cfg) continue
    const { data: convs } = await db
      .from('conversations')
      .select('id, contact_id, ai_autoreply_disabled, assigned_agent_id')
      .eq('account_id', accountId)
      .gte('last_inbound_at', new Date(ahora - VENTANA_MS).toISOString())
      .lte('last_inbound_at', new Date(ahora - MIN_ESPERA_MS).toISOString())
    for (const c of convs ?? []) {
      res.revisadas++
      if (c.assigned_agent_id) continue   // una persona del equipo la tiene asignada
      const { data: ult } = await db
        .from('messages')
        .select('sender_type, content_type, created_at, message_id')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!quedaPendiente(ult, ahora)) continue
      if (c.ai_autoreply_disabled) {
        await db.from('conversations').update({ ai_autoreply_disabled: false, ai_handoff_summary: null }).eq('id', c.id)
        res.reactivadas++
      }
      await dispatchInboundToAiReply({
        accountId, conversationId: c.id, contactId: c.contact_id, configOwnerUserId: cfg.user_id,
        inboundMessageId: ult?.message_id ?? undefined,
      })
      const { data: despues } = await db.from('messages').select('sender_type').eq('conversation_id', c.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (despues && despues.sender_type !== 'customer') {
        res.contestadas++
        await db.from('contact_notes').insert({ contact_id: c.contact_id, user_id: cfg.user_id, account_id: accountId,
          note_text: '🔁 Barrido de pendientes: el agente contestó un mensaje que se había quedado sin respuesta.' })
      } else {
        res.detalle.push(`sin contestar: conversación ${c.id}`)
      }
    }
  }
  return res
}
