/**
 * Notas de voz → texto, para que el agente IA las lea y conteste.
 *
 * Dos caminos, en este orden:
 *   1. DeepSeek ASR (`/v1/tools/asr`) con la clave de la cuenta — es el que se
 *      usa cuando el orquestador está encendido, y solo acepta español.
 *   2. Respaldo histórico con la API de OpenAI (OPENAI_API_KEY), para no romper
 *      nada si la cuenta todavía no tiene orquestador.
 *
 * Sin clave, o si algo falla, devuelve null y el mensaje sigue como audio
 * normal. Nunca lanza.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { transcribirNota } from './comprension/asr'

const MODELO = process.env.AI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
const MAX_BYTES = 20 * 1024 * 1024

/** Versión con cuenta: intenta DeepSeek y, si no aplica, cae al respaldo. */
export async function transcribirNotaDeVozDeCuenta(args: {
  db: SupabaseClient
  accountId: string
  mediaUrl: string | null
  accessToken?: string | null
  mimeType?: string | null
}): Promise<string | null> {
  try {
    const config = await loadAiConfig(args.db, args.accountId).catch(() => null)
    if (config?.orquestador) {
      const resultado = await transcribirNota({
        config,
        mediaUrl: args.mediaUrl,
        accessToken: args.accessToken,
        mimeType: args.mimeType,
      })
      if (resultado?.texto) {
        const segundos = resultado.durationMs ? Math.round(resultado.durationMs / 1000) : null
        console.log(
          `[orquestador] nota de voz transcrita (${resultado.modelo}) en ${resultado.latencyMs} ms${segundos ? ` · ${segundos}s de audio` : ''}`,
        )
        return resultado.texto
      }
      // Con el orquestador encendido no se cae a OpenAI: si DeepSeek no pudo,
      // se deja el audio sin transcribir a propósito (una cuenta, un proveedor).
      return null
    }
  } catch (err) {
    console.warn('[nota de voz] no se pudo resolver la configuración:', err instanceof Error ? err.message : err)
  }
  return transcribirNotaDeVoz(args.mediaUrl, args.mimeType)
}

export async function transcribirNotaDeVoz(mediaUrl: string | null, mimeType?: string | null): Promise<string | null> {
  const clave = process.env.OPENAI_API_KEY
  if (!clave || !mediaUrl || !/^https?:\/\//.test(mediaUrl)) return null
  try {
    const audio = await fetch(mediaUrl, { signal: AbortSignal.timeout(20_000) })
    if (!audio.ok) return null
    const bytes = await audio.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null
    const tipo = (mimeType || 'audio/ogg').split(';')[0].trim()
    const ext = tipo.includes('mpeg') ? 'mp3' : tipo.includes('mp4') || tipo.includes('aac') ? 'm4a' : tipo.includes('amr') ? 'amr' : 'ogg'
    const form = new FormData()
    form.append('model', MODELO)
    form.append('language', 'es')
    form.append('file', new Blob([bytes], { type: tipo }), `nota.${ext}`)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${clave}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      console.warn('[nota de voz] la transcripción falló:', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { text?: string }
    const texto = data.text?.trim()
    return texto ? texto : null
  } catch (err) {
    console.warn('[nota de voz] no se pudo transcribir:', err instanceof Error ? err.message : err)
    return null
  }
}
