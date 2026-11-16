import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 5: la IA propone con contexto. Aquí se prueba la parte
 * determinista — qué preguntó la clienta y qué se le ha comunicado ya —
 * que es la que hace que la respuesta sea la adecuada y no un discurso
 * repetido.
 */

const h = vi.hoisted(() => ({ filas: [] as Array<Record<string, unknown>> }))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      order: () => b,
      limit: async () => ({ data: h.filas, error: null }),
    })
    return { from: () => b }
  },
}))

import { detectarIntencion, guiaDeRespuesta, temasEn } from './intencion'
import { memoriaDe, resumenMemoria } from './memoria'

beforeEach(() => {
  h.filas = []
})

describe('detección de intención', () => {
  it('reconoce lo que la clienta pregunta', () => {
    expect(detectarIntencion('hola, cuánto cuesta?')).toBe('PRICE_REQUEST')
    expect(detectarIntencion('¿qué incluye?')).toBe('CONTENT')
    expect(detectarIntencion('¿trae bonos?')).toBe('BONUSES')
    expect(detectarIntencion('¿cómo pago?')).toBe('PAYMENT')
    expect(detectarIntencion('¿me lo mandas en pdf?')).toBe('DELIVERY')
    expect(detectarIntencion('sí, lo quiero')).toBe('BUY')
    expect(detectarIntencion('lo voy a pensar')).toBe('OBJECTION')
    expect(detectarIntencion('quiero hablar con una persona')).toBe('HUMAN')
    expect(detectarIntencion('no me escribas más')).toBe('OPT_OUT')
    expect(detectarIntencion('hola')).toBe('GREETING')
  })

  it('no confunde el saludo con una pregunta', () => {
    expect(detectarIntencion('buenas tardes')).toBe('GREETING')
  })
})

describe('temas que menciona y guía de respuesta', () => {
  it('detecta los temas del mensaje', () => {
    expect(temasEn('¿cuánto cuesta el pack?')).toContain('precio')
    expect(temasEn('¿cómo hago el depósito en OXXO?')).toContain('pago')
  })

  it('dice qué contestar y qué no repetir', () => {
    const guia = guiaDeRespuesta({
      intencion: 'PRICE_REQUEST',
      memoria: { precio: true, pago: true },
      temasPreguntados: ['precio'],
    })
    expect(guia).toContain('preguntó el precio')
    expect(guia).toContain('1 o 2 renglones')
    // El precio ya se dijo y lo vuelve a preguntar: corto, sin repetir todo.
    expect(guia).toContain('sin repetir el bloque completo')
    // El pago ya se dijo y no lo pide: no volver a explicarlo.
    expect(guia).toContain('NO vuelvas a explicar pago')
  })

  it('con una objeción pide no insistir', () => {
    const guia = guiaDeRespuesta({
      intencion: 'OBJECTION',
      memoria: {},
      temasPreguntados: [],
    })
    expect(guia).toContain('NO insistas')
  })

  it('siempre recuerda dejar la conversación esperando a la clienta', () => {
    const guia = guiaDeRespuesta({ intencion: 'OTHER', memoria: {}, temasPreguntados: [] })
    expect(guia).toContain('no adelantes el siguiente paso')
  })
})

describe('memoria de la conversación', () => {
  it('deduce lo ya comunicado del registro de salida', async () => {
    h.filas = [
      { content_preview: 'El aporte es voluntario: 100, 150 o 200 pesos', workflow_node_key: 'texto_aporte' },
      { content_preview: 'Transfiere por SPEI o en OXXO', workflow_node_key: 'pago' },
      { content_preview: '🎄 ¿Te gustaría que tus regalos...?', workflow_node_key: 'imagen_1' },
    ]
    const m = await memoriaDe('conv-1')
    expect(m.precio || m.pago).toBe(true)
    expect(m.pago).toBe(true)
    expect(resumenMemoria(m)).toContain('pago')
  })

  it('con la conversación vacía no da nada por dicho', async () => {
    const m = await memoriaDe('conv-1')
    expect(resumenMemoria(m)).toBe('nada todavía')
  })
})
