import { generateReply } from './generate'
import type { AiConfig } from './types'

/**
 * Cheap liveness + auth check: one tiny generation against the
 * configured provider/model with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * on success. Used by the settings "Test key" button and before
 * persisting a config — the same "verify before save" discipline the
 * WhatsApp config uses with Meta.
 */
export async function validateAiCredentials(
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey' | 'baseUrl'> & Partial<AiConfig>,
): Promise<void> {
  // La comprobación solo necesita credenciales: el resto de los campos se
  // rellenan con valores neutros para no obligar a los llamadores (formulario
  // de ajustes y botón de prueba) a construir un AiConfig completo.
  const completo: AiConfig = {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    systemPrompt: config.systemPrompt ?? null,
    isActive: config.isActive ?? true,
    autoReplyEnabled: config.autoReplyEnabled ?? false,
    autoReplyMaxPerConversation: config.autoReplyMaxPerConversation ?? 3,
    handoffAgentId: config.handoffAgentId ?? null,
    embeddingsApiKey: config.embeddingsApiKey ?? null,
    visionModel: config.visionModel ?? null,
    asrModel: config.asrModel ?? null,
    orquestador: config.orquestador ?? false,
    catalogStrict: config.catalogStrict ?? true,
  }
  await generateReply({
    config: completo,
    systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  })
}
