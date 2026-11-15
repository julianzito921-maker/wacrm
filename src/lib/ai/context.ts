import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type?: string
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    // Las notas de voz de la clienta llegan transcritas en content_text.
    // Los botones también: el texto del mensaje con botones (preguntas y ofertas del
    // embudo) y el botón que tocó la clienta.
    // Y los PDF que ya mandamos (su pie de texto), para que la IA no los repita.
    .in('content_type', ['text', 'audio', 'interactive', 'document'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .filter((m) => m.content_type !== 'audio' || m.sender_type === 'customer')
    .filter((m) => m.content_type !== 'document' || m.sender_type !== 'customer')
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content:
        m.content_type === 'audio'
          ? `[Nota de voz] ${m.content_text!.trim()}`
          : m.content_type === 'document'
            ? `[Archivo PDF enviado] ${m.content_text!.trim()}`
          : m.content_type === 'interactive' && m.sender_type === 'customer'
            ? `[Tocó el botón] ${m.content_text!.trim()}`
            : m.content_text!.trim(),
    }))
}
