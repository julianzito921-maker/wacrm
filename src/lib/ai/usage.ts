import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft' | 'vision' | 'asr'
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
  /** Etapa del orquestador que gastó los tokens: texto | vision | asr. */
  origen?: string
  /** Duración de la llamada al proveedor, para medir latencia por etapa. */
  latencyMs?: number
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    const fila: Record<string, unknown> = {
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    }
    // Solo se envían cuando existen, para no cambiar el payload histórico
    // de las llamadas de texto ya en producción.
    if (args.origen !== undefined) fila.origen = args.origen
    if (args.latencyMs !== undefined) fila.latency_ms = Math.round(args.latencyMs)

    const { error } = await db.from('ai_usage_log').insert(fila)
    if (error) {
      // Si la migración 062 todavía no está aplicada, `origen` / `latency_ms`
      // no existen como columnas y el insert completo fallaría. En ese caso se
      // reintenta con el payload de siempre para no perder el registro de uso.
      if (args.origen !== undefined || args.latencyMs !== undefined) {
        const legado = {
          account_id: args.accountId,
          conversation_id: args.conversationId,
          mode: args.mode,
          provider: args.provider,
          model: args.model,
          prompt_tokens: args.usage.promptTokens,
          completion_tokens: args.usage.completionTokens,
          total_tokens: args.usage.totalTokens,
        }
        const { error: errorLegado } = await db.from('ai_usage_log').insert(legado)
        if (!errorLegado) return
        console.error('[ai usage] log insert failed (reintento sin métricas):', errorLegado)
        return
      }
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
