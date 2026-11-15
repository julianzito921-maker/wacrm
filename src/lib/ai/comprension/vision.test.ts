import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { interpretarLectura, leerImagen, orquestadorActivo } from './vision'
import type { AiConfig } from '../types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai_compatible',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 20,
    handoffAgentId: null,
    embeddingsApiKey: null,
    visionModel: null,
    asrModel: null,
    orquestador: true,
    catalogStrict: true,
    ...overrides,
  }
}

/** Base de datos falsa: registra inserts por tabla y permite fijar la caché. */
function fakeDb(cache: unknown = null) {
  const inserts: { tabla: string; fila: unknown }[] = []
  const db = {
    from(tabla: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cache, error: null }) }) }),
        insert: async (fila: unknown) => {
          inserts.push({ tabla, fila })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
    },
  }
  return { db: db as unknown as SupabaseClient, inserts }
}

const RESPUESTA_OK = {
  choices: [{ message: { content: '{"clase":"producto","resumen":"Un amigurumi de reno a medio tejer.","datos":{"color":"café"}}' } }],
  usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('orquestadorActivo', () => {
  it('está apagado sin configuración o con el interruptor en false', () => {
    expect(orquestadorActivo(null)).toBe(false)
    expect(orquestadorActivo(config({ orquestador: false }))).toBe(false)
  })

  it('está encendido con el interruptor en true', () => {
    expect(orquestadorActivo(config())).toBe(true)
  })
})

describe('interpretarLectura', () => {
  it('lee el JSON del modelo', () => {
    const l = interpretarLectura(RESPUESTA_OK.choices[0].message.content, 'deepseek-flash', 1200)
    expect(l.clase).toBe('producto')
    expect(l.resumen).toContain('reno')
    expect(l.datos).toEqual({ color: 'café' })
    expect(l.latencyMs).toBe(1200)
  })

  it('tolera el bloque de código que a veces devuelve el modelo', () => {
    const l = interpretarLectura('```json\n{"clase":"comprobante","resumen":"Transferencia de $150"}\n```', 'm', 10)
    expect(l.clase).toBe('comprobante')
    expect(l.resumen).toBe('Transferencia de $150')
  })

  it('si contesta texto suelto, lo usa como resumen', () => {
    const l = interpretarLectura('Se ve una foto borrosa de un tejido.', 'm', 10)
    expect(l.clase).toBe('otro')
    expect(l.resumen).toContain('borrosa')
  })

  it('una clase desconocida cae en «otro»', () => {
    const l = interpretarLectura('{"clase":"no_existe","resumen":"algo"}', 'm', 10)
    expect(l.clase).toBe('otro')
  })

  it('con respuesta vacía no inventa resumen', () => {
    expect(interpretarLectura('', 'm', 5).resumen).toBe('')
  })
})

describe('leerImagen', () => {
  it('no gasta nada cuando el orquestador está apagado', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db } = fakeDb()
    const l = await leerImagen({ db, accountId: 'a', config: config({ orquestador: false }), mediaUrl: 'https://x/y.jpg' })
    expect(l).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no usa el adaptador de Anthropic, que es solo texto', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db } = fakeDb()
    const l = await leerImagen({ db, accountId: 'a', config: config({ provider: 'anthropic' }), mediaUrl: 'https://x/y.jpg' })
    expect(l).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('devuelve la lectura guardada sin volver a pagar por la imagen', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db } = fakeDb({ clase: 'producto', contenido: { resumen: 'Ya leída', datos: {} }, modelo: 'deepseek-flash' })
    const l = await leerImagen({ db, accountId: 'a', messageId: 'm1', config: config(), mediaUrl: 'https://x/y.jpg' })
    expect(l?.resumen).toBe('Ya leída')
    expect(l?.cacheada).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('manda la imagen en modo barato, guarda el resultado y registra el uso', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESPUESTA_OK), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { db, inserts } = fakeDb()

    const l = await leerImagen({
      db,
      accountId: 'acct-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      config: config(),
      mediaUrl: 'https://cdn/x.jpg',
      caption: 'mira',
    })

    expect(l?.clase).toBe('producto')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const cuerpo = JSON.parse(String(opciones.body))
    expect(cuerpo.model).toBe('deepseek-flash')
    const bloque = cuerpo.messages[0].content
    expect(bloque[0].type).toBe('text')
    expect(bloque[0].text).toContain('mira')
    expect(bloque[1]).toEqual({ type: 'image_url', image_url: { url: 'https://cdn/x.jpg', detail: 'low' } })
    expect(cuerpo.max_tokens).toBeLessThanOrEqual(300)

    const guardado = inserts.find((i) => i.tabla === 'media_understanding')
    expect(guardado).toBeTruthy()

    // El registro de uso es fire-and-forget.
    await new Promise((r) => setImmediate(r))
    const uso = inserts.find((i) => i.tabla === 'ai_usage_log')?.fila as Record<string, unknown> | undefined
    expect(uso?.mode).toBe('vision')
    expect(uso?.origen).toBe('vision')
    expect(uso?.total_tokens).toBe(940)
  })

  it('usa el modelo de visión configurado cuando existe', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RESPUESTA_OK), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { db } = fakeDb()
    await leerImagen({ db, accountId: 'a', config: config({ visionModel: 'deepseek-v4-pro' }), mediaUrl: 'https://cdn/x.jpg' })
    const cuerpo = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(cuerpo.model).toBe('deepseek-v4-pro')
  })

  it('no revienta si el proveedor falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const { db, inserts } = fakeDb()
    const l = await leerImagen({ db, accountId: 'a', config: config(), mediaUrl: 'https://cdn/x.jpg' })
    expect(l).toBeNull()
    expect(inserts.some((i) => i.tabla === 'media_understanding')).toBe(false)
  })

  it('no revienta si la red se cae', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red') }))
    const { db } = fakeDb()
    await expect(leerImagen({ db, accountId: 'a', config: config(), mediaUrl: 'https://cdn/x.jpg' })).resolves.toBeNull()
  })

  it('sin fuente de imagen no llama al modelo', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db } = fakeDb()
    const l = await leerImagen({ db, accountId: 'a', config: config(), mediaUrl: null, mediaId: null })
    expect(l).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
