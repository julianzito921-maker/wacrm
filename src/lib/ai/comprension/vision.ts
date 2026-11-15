// ============================================================
// Comprensión de imágenes (Etapa 2 del orquestador).
//
// Cuando una clienta manda una foto —su tejido, una duda, una captura— el
// agente no puede verla: el contexto que se le pasa es texto. Este módulo
// convierte la imagen en una frase que sí puede leer, y la guarda para no
// pagar dos veces por el mismo mensaje.
//
// Reglas de diseño:
//   · Nunca lanza. Si la lectura falla, la conversación sigue como antes.
//   · Se apaga con `ai_configs.orquestador`; sin ese interruptor no se gasta
//     un solo token en visión.
//   · Nunca se le manda la imagen al modelo de chat: se le manda el resumen.
//   · El proveedor debe ser compatible con OpenAI (DeepSeek lo es); el
//     adaptador de Anthropic de este repo es solo texto.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAiUsage } from '../usage'
import { normalizeUsage } from '../providers/shared'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import type { AiConfig } from '../types'

export type ClaseImagen = 'comprobante' | 'producto' | 'conversacion' | 'otro'

export interface LecturaImagen {
  clase: ClaseImagen
  resumen: string
  datos: Record<string, unknown>
  modelo: string
  latencyMs: number
  /** true cuando salió de la caché y no se gastó tokens. */
  cacheada?: boolean
}

/** Tamaño máximo que aceptamos descargar para leer (los espejos suelen ser 5 MB). */
const MAX_BYTES = 5 * 1024 * 1024

const PROMPT = [
  'Eres un asistente que mira la foto que envió una clienta por WhatsApp a una tienda de patrones de amigurumi.',
  'Describe en español, en una o dos frases, SOLO lo que se ve y lo que le sirve a quien responde el chat.',
  'Si la foto parece un comprobante de pago, dilo y anota el importe y la fecha si se leen.',
  'Si es una pieza tejida, describe la pieza y si parece terminada o en proceso.',
  'No inventes nada que no esté en la imagen.',
  'Responde únicamente con un JSON así:',
  '{"clase":"producto","resumen":"...","datos":{}}',
  'Valores válidos de clase: comprobante, producto, conversacion, otro.',
].join('\n')

export function orquestadorActivo(config: AiConfig | null | undefined): boolean {
  return Boolean(config?.orquestador)
}

function baseUrlDe(config: AiConfig): string {
  const base = (config.baseUrl ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function limpiarJson(texto: string): string {
  const sinCerca = texto
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const inicio = sinCerca.indexOf('{')
  const fin = sinCerca.lastIndexOf('}')
  return inicio >= 0 && fin > inicio ? sinCerca.slice(inicio, fin + 1) : sinCerca
}

function claseValida(valor: unknown): ClaseImagen {
  return valor === 'comprobante' || valor === 'producto' || valor === 'conversacion' ? valor : 'otro'
}

/** Interpreta la respuesta del modelo, acepte JSON o texto suelto. */
export function interpretarLectura(
  contenido: string,
  modelo: string,
  latencyMs: number,
): LecturaImagen {
  const bruto = (contenido ?? '').trim()
  if (!bruto) return { clase: 'otro', resumen: '', datos: {}, modelo, latencyMs }
  try {
    const json = JSON.parse(limpiarJson(bruto)) as { clase?: unknown; resumen?: unknown; datos?: unknown }
    const resumen = typeof json.resumen === 'string' ? json.resumen.trim() : ''
    return {
      clase: claseValida(json.clase),
      resumen: resumen || bruto.slice(0, 300),
      datos: json.datos && typeof json.datos === 'object' ? (json.datos as Record<string, unknown>) : {},
      modelo,
      latencyMs,
    }
  } catch {
    // El modelo contestó texto en vez de JSON: sirve igual como resumen.
    return { clase: 'otro', resumen: bruto.slice(0, 300), datos: {}, modelo, latencyMs }
  }
}

interface FilaEntendida {
  clase: string
  contenido: { resumen?: string; datos?: Record<string, unknown> } | null
  modelo: string | null
}

/**
 * Lee una imagen y devuelve su resumen. Devuelve null cuando el orquestador
 * está apagado, cuando ya estaba leída, o cuando algo falla.
 */
export async function leerImagen(args: {
  db: SupabaseClient
  accountId: string
  conversationId?: string | null
  messageId?: string | null
  config: AiConfig | null
  /** URL pública espejada; si viene, no se descarga nada de Meta. */
  mediaUrl?: string | null
  /** Alternativa: id de Meta para descargar los bytes. */
  mediaId?: string | null
  accessToken?: string | null
  /** Texto que acompañaba la foto, si lo había. */
  caption?: string | null
}): Promise<LecturaImagen | null> {
  const { db, accountId, config } = args
  if (!orquestadorActivo(config)) return null
  if (config?.provider === 'anthropic') return null

  // 1. Caché: un mensaje se entiende una sola vez.
  if (args.messageId) {
    try {
      const { data } = await db
        .from('media_understanding')
        .select('clase, contenido, modelo')
        .eq('message_id', args.messageId)
        .maybeSingle()
      const fila = data as unknown as FilaEntendida | null
      if (fila?.contenido?.resumen) {
        return {
          clase: claseValida(fila.clase),
          resumen: fila.contenido.resumen,
          datos: fila.contenido.datos ?? {},
          modelo: fila.modelo ?? config?.visionModel ?? config?.model ?? '',
          latencyMs: 0,
          cacheada: true,
        }
      }
    } catch {
      // Sin caché se sigue: solo cuesta una lectura de más.
    }
  }

  // 2. Fuente de la imagen: URL pública o bytes de Meta.
  let fuente: string | null = args.mediaUrl?.trim() || null
  if (!fuente && args.mediaId && args.accessToken) {
    try {
      const info = await getMediaUrl({ mediaId: args.mediaId, accessToken: args.accessToken })
      const { buffer, contentType } = await downloadMedia({ downloadUrl: info.url, accessToken: args.accessToken })
      if (buffer.byteLength > MAX_BYTES) {
        console.warn('[vision] imagen demasiado grande, se ignora:', buffer.byteLength)
        return null
      }
      fuente = `data:${contentType || info.mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}`
    } catch (err) {
      console.warn('[vision] no se pudo obtener la imagen:', err instanceof Error ? err.message : err)
      return null
    }
  }
  if (!fuente) return null

  // 3. Llamada al modelo con visión (compatible OpenAI).
  const modelo = config?.visionModel?.trim() || config?.model || 'deepseek-flash'
  const inicio = Date.now()
  try {
    const respuesta = await fetch(`${baseUrlDe(config!)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config!.apiKey}`,
      },
      body: JSON.stringify({
        model: modelo,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: args.caption ? `${PROMPT}\nTexto que acompañaba la foto: ${args.caption}` : PROMPT,
              },
              // detail: low baja la imagen a 512x512: suficiente para describir
              // y varias veces más barato que la resolución original.
              { type: 'image_url', image_url: { url: fuente, detail: 'low' } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 220,
        // DeepSeek trae el modo pensamiento activado por defecto y con 220
        // tokens se los gasta razonando: la descripción llegaba vacía.
        // Describir una foto no necesita cadena de pensamiento.
        thinking: { type: 'disabled' },
      }),
    })

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text().catch(() => '')
      console.warn(`[vision] el proveedor respondió ${respuesta.status}: ${cuerpo.slice(0, 160)}`)
      return null
    }

    const datos = (await respuesta.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const latencyMs = Date.now() - inicio
    const lectura = interpretarLectura(datos.choices?.[0]?.message?.content ?? '', modelo, latencyMs)
    if (!lectura.resumen) return null

    // 4. Métricas y caché (las dos best-effort).
    void logAiUsage(db, {
      accountId,
      conversationId: args.conversationId ?? null,
      mode: 'vision',
      provider: config!.provider,
      model: modelo,
      usage: normalizeUsage({
        prompt: datos.usage?.prompt_tokens,
        completion: datos.usage?.completion_tokens,
        total: datos.usage?.total_tokens,
      }),
      origen: 'vision',
      latencyMs,
    })

    if (args.messageId) {
      try {
        await db.from('media_understanding').insert({
          account_id: accountId,
          message_id: args.messageId,
          clase: lectura.clase,
          modelo,
          contenido: { resumen: lectura.resumen, datos: lectura.datos },
          latency_ms: latencyMs,
        })
      } catch {
        // Carrera con otra lectura del mismo mensaje: no es un problema.
      }
    }

    return lectura
  } catch (err) {
    console.warn('[vision] falló la lectura:', err instanceof Error ? err.message : err)
    return null
  }
}
