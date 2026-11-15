// ============================================================
// Notas de voz → texto con DeepSeek ASR (Etapa 3 del orquestador).
//
// Por qué no OpenAI: DeepSeek expone `POST /v1/tools/asr` con la misma clave
// de la cuenta, acepta el Ogg Opus que manda WhatsApp sin convertir nada y
// cuesta $0,058–0,116 por hora de audio.
//
// Límites reales del endpoint (por eso se comprueban antes de subir):
//   · formato 16-bit PCM WAV u Ogg Opus, detectado por el contenido
//   · máximo 8 MiB y máximo 120 segundos
//   · el idioma lo detecta solo: no hay parámetro de idioma, así que para
//     «solo español» se filtra el resultado con `esEspanol`.
// ============================================================

import { downloadMedia } from '@/lib/whatsapp/meta-api'
import type { AiConfig } from '../types'

export interface ResultadoAsr {
  texto: string
  durationMs: number | null
  modelo: string
  latencyMs: number
}

/** 8 MiB es el techo del endpoint; dejamos margen para el multipart. */
export const MAX_BYTES = 8 * 1024 * 1024
export const MODELO_POR_DEFECTO = 'deepseek-asr'

const MIMES_ACEPTADOS = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/ogg; codecs=opus',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
])

export function mimeAceptado(mimeType?: string | null): boolean {
  if (!mimeType) return false
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return MIMES_ACEPTADOS.has(base) || MIMES_ACEPTADOS.has(mimeType.trim().toLowerCase())
}

/** ¿Está configurado para transcribir solo español? (por defecto sí) */
export function soloEspanol(): boolean {
  return process.env.AI_ASR_SOLO_ESPANOL !== 'off'
}

const PALABRAS_ES = new Set([
  'que', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero', 'si', 'no',
  'me', 'te', 'se', 'lo', 'le', 'mi', 'tu', 'su', 'es', 'son', 'esta', 'estan', 'hay', 'para', 'por',
  'con', 'sin', 'como', 'cuando', 'cuanto', 'donde', 'hola', 'buenas', 'gracias', 'favor', 'quiero',
  'quiere', 'tiene', 'tengo', 'puedo', 'puede', 'manda', 'mandame', 'precio', 'dinero', 'pago',
  'pagar', 'bueno', 'bien', 'muy', 'mas', 'menos', 'todo', 'nada', 'algo', 'tambien', 'usted',
  'ustedes', 'nosotros', 'yo', 'ella', 'estoy', 'seria', 'podrias', 'cuánto', 'cómo', 'qué',
])

/** Marcas que delatan otros idiomas cercanos (portugués, francés, alemán). */
const MARCAS_OTROS = /[ãõçßœæëÿğışłřž]/

/**
 * ¿Parece español? Es un filtro barato, sin llamadas ni tokens: el objetivo es
 * no responder como si hubiéramos entendido una nota de voz en otro idioma.
 */
export function esEspanol(texto: string): boolean {
  const original = (texto ?? '').trim()
  if (!original) return false
  const t = original.toLowerCase()
  if (MARCAS_OTROS.test(t)) return false
  if (/[¿¡]/.test(original)) return true
  // Sin tildes para poder comparar con la lista de palabras («sí» → «si»).
  const plano = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const palabras = plano
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (palabras.length === 0) return false
  const aciertos = palabras.filter((p) => PALABRAS_ES.has(p)).length
  const tieneTilde = /[áéíóúüñ]/.test(t)
  if (aciertos >= 2) return true
  // «sí, órale»: una sola palabra conocida, pero lleva tilde.
  if (tieneTilde && aciertos >= 1) return true
  if (tieneTilde && palabras.length <= 3) return true
  return aciertos / palabras.length >= 0.15
}

function baseUrlDe(config: AiConfig): string {
  const base = (config.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function nombreArchivo(mimeType: string | null | undefined): string {
  const tipo = (mimeType ?? 'audio/ogg').toLowerCase()
  if (tipo.includes('wav')) return 'nota.wav'
  return 'nota.ogg'
}

/**
 * Transcribe una nota de voz con DeepSeek. Devuelve null cuando el orquestador
 * está apagado, el formato no sirve, el audio pesa demasiado, la transcripción
 * no parece español (si está activado «solo español») o algo falla.
 * Nunca lanza.
 */
export async function transcribirNota(args: {
  config: AiConfig | null
  /** URL de descarga de Meta (necesita el token) o URL pública espejada. */
  mediaUrl?: string | null
  accessToken?: string | null
  mimeType?: string | null
}): Promise<ResultadoAsr | null> {
  const { config } = args
  if (!config?.orquestador) return null
  if (config.provider === 'anthropic') return null
  if (!args.mediaUrl) return null
  if (!mimeAceptado(args.mimeType)) {
    console.warn('[asr] formato no soportado por DeepSeek:', args.mimeType ?? '(sin mime)')
    return null
  }

  const modelo = config.asrModel?.trim() || MODELO_POR_DEFECTO
  const inicio = Date.now()
  try {
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: args.mediaUrl,
      accessToken: args.accessToken ?? '',
    })
    if (!buffer || buffer.byteLength === 0) return null
    if (buffer.byteLength > MAX_BYTES) {
      console.warn('[asr] audio demasiado grande:', buffer.byteLength)
      return null
    }

    const tipo = (contentType || args.mimeType || 'audio/ogg').split(';')[0].trim()
    const form = new FormData()
    const bytes = new Uint8Array(buffer)
    form.append('file', new Blob([bytes], { type: tipo }), nombreArchivo(tipo))

    const respuesta = await fetch(`${baseUrlDe(config)}/tools/asr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text().catch(() => '')
      console.warn(`[asr] el proveedor respondió ${respuesta.status}: ${cuerpo.slice(0, 160)}`)
      return null
    }

    const datos = (await respuesta.json()) as { text?: string; duration_ms?: number }
    const texto = (datos.text ?? '').trim()
    const latencyMs = Date.now() - inicio
    if (!texto) return null

    if (soloEspanol() && !esEspanol(texto)) {
      console.warn('[asr] la nota de voz no parece español: se ignora la transcripción')
      return null
    }

    return {
      texto,
      durationMs: typeof datos.duration_ms === 'number' ? datos.duration_ms : null,
      modelo,
      latencyMs,
    }
  } catch (err) {
    console.warn('[asr] falló la transcripción:', err instanceof Error ? err.message : err)
    return null
  }
}
