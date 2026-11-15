import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { esEspanol, mimeAceptado, soloEspanol, transcribirNota } from './asr'
import type { AiConfig } from '../types'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('audio-falso'), contentType: 'audio/ogg' })),
}))

import { downloadMedia } from '@/lib/whatsapp/meta-api'

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
    visionModel: 'deepseek-flash',
    asrModel: null,
    orquestador: true,
    catalogStrict: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  delete process.env.AI_ASR_SOLO_ESPANOL
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mimeAceptado', () => {
  it('acepta lo que DeepSeek soporta: Ogg Opus y WAV', () => {
    expect(mimeAceptado('audio/ogg')).toBe(true)
    expect(mimeAceptado('audio/ogg; codecs=opus')).toBe(true)
    expect(mimeAceptado('audio/wav')).toBe(true)
    expect(mimeAceptado('audio/x-wav')).toBe(true)
  })

  it('rechaza lo que no soporta', () => {
    expect(mimeAceptado('audio/mpeg')).toBe(false)
    expect(mimeAceptado('audio/mp4')).toBe(false)
    expect(mimeAceptado('audio/amr')).toBe(false)
    expect(mimeAceptado(null)).toBe(false)
  })
})

describe('soloEspanol', () => {
  it('viene activado y se apaga con AI_ASR_SOLO_ESPANOL=off', () => {
    expect(soloEspanol()).toBe(true)
    process.env.AI_ASR_SOLO_ESPANOL = 'off'
    expect(soloEspanol()).toBe(false)
  })
})

describe('esEspanol', () => {
  it('reconoce español normal de una clienta', () => {
    expect(esEspanol('hola, cuánto cuesta el pack de patrones?')).toBe(true)
    expect(esEspanol('¿me lo puedes mandar?')).toBe(true)
    expect(esEspanol('ya hice el pago, te mando el comprobante')).toBe(true)
  })

  it('reconoce español corto con acentos', () => {
    expect(esEspanol('sí, órale')).toBe(true)
  })

  it('descarta otros idiomas cercanos', () => {
    expect(esEspanol('obrigado pela atenção, vou fazer o pagamento')).toBe(false)
    expect(esEspanol('bonjour, combien ça coûte le pack')).toBe(false)
  })

  it('descarta inglés', () => {
    expect(esEspanol('hello, how much is the pack')).toBe(false)
  })

  it('con texto vacío no se arriesga', () => {
    expect(esEspanol('')).toBe(false)
    expect(esEspanol('   ')).toBe(false)
  })
})

describe('transcribirNota', () => {
  const ok = (texto: string, duracion = 3200) =>
    new Response(JSON.stringify({ request_id: 'r1', text: texto, duration_ms: duracion }), { status: 200 })

  it('no llama a nada si el orquestador está apagado', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await transcribirNota({ config: config({ orquestador: false }), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rechaza formatos que DeepSeek no acepta sin gastar llamada', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.m4a', mimeType: 'audio/mp4' })
    expect(r).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('transcribe subiendo el archivo al endpoint de DeepSeek', async () => {
    const fetchMock = vi.fn(async () => ok('hola, cuánto cuesta el pack'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r?.texto).toBe('hola, cuánto cuesta el pack')
    expect(r?.durationMs).toBe(3200)
    const [url, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/tools/asr')
    expect(String((opciones.headers as Record<string, string>).Authorization)).toContain('Bearer')
    expect(opciones.body).toBeInstanceOf(FormData)
    expect(downloadMedia).toHaveBeenCalled()
  })

  it('ignora la transcripción cuando no es español', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('thank you so much for the patterns')))
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r).toBeNull()
  })

  it('acepta otros idiomas si se apaga el filtro', async () => {
    process.env.AI_ASR_SOLO_ESPANOL = 'off'
    vi.stubGlobal('fetch', vi.fn(async () => ok('thank you so much')))
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r?.texto).toBe('thank you so much')
  })

  it('usa el modelo de ASR configurado cuando existe', async () => {
    const fetchMock = vi.fn(async () => ok('hola, quiero el pack'))
    vi.stubGlobal('fetch', fetchMock)
    await transcribirNota({ config: config({ asrModel: 'otro-asr' }), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('no revienta si el proveedor falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r).toBeNull()
  })

  it('no revienta si la descarga se cae', async () => {
    vi.mocked(downloadMedia).mockRejectedValueOnce(new Error('sin red'))
    const r = await transcribirNota({ config: config(), mediaUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' })
    expect(r).toBeNull()
  })
})
