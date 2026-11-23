import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Avisos a Julián por WhatsApp: traspaso a humano (salida real a una
 * persona, como exige Meta) y resumen de problemas del embudo.
 */

const h = vi.hoisted(() => ({
  plantillas: [] as Array<Record<string, unknown>>,
  textos: [] as Array<Record<string, unknown>>,
  alertas: [] as Array<Record<string, unknown>>,
  falla: false,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: tabla === 'whatsapp_config' ? [{ account_id: 'acc-1' }] : [], error: null }),
        maybeSingle: async () => ({ data: { name: 'Roberta', phone: '5215511112222' }, error: null }),
        insert: async (fila: Record<string, unknown>) => {
          h.alertas.push(fila)
          return { error: null }
        },
      })
      return b
    },
  }),
}))

vi.mock('@/lib/flows/meta-send', () => ({
  loadAccountMetaCredentials: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}))

vi.mock('./send', () => ({
  enviarPlantilla: async (a: Record<string, unknown>) => {
    if (h.falla) throw new Error('Meta API error: 400 {"error":{"code":131047}}')
    h.plantillas.push(a)
    return { messageId: 'wamid.p' }
  },
  enviarTexto: async (a: Record<string, unknown>) => {
    if (h.falla) throw new Error('fuera de ventana')
    h.textos.push(a)
    return { messageId: 'wamid.t' }
  },
}))

import {
  avisarAJulian,
  avisarTraspasoHumano,
  hayProblemas,
  numeroAviso,
  textoParaPlantilla,
  textoResumen,
} from './avisos'

beforeEach(() => {
  h.plantillas = []
  h.textos = []
  h.alertas = []
  h.falla = false
  process.env.ALERTA_WHATSAPP = '56 2071 4773'
})
afterEach(() => {
  delete process.env.ALERTA_WHATSAPP
  delete process.env.ALERTA_PLANTILLA
})

describe('formato', () => {
  it('normaliza el número de México', () => {
    expect(numeroAviso('56 2071 4773')).toBe('525620714773')
    expect(numeroAviso('5215620714773')).toBe('525620714773')
    expect(numeroAviso('525620714773')).toBe('525620714773')
    expect(numeroAviso('')).toBeNull()
  })
  it('el parámetro de plantilla no lleva saltos de línea ni espacios de más', () => {
    expect(textoParaPlantilla('Hola\n\nmundo     ahí')).toBe('Hola · mundo ahí')
  })
  it('los frenos normales no cuentan como problema', () => {
    const base = { rechazadosMeta: {}, frenados: { opt_out: 3 }, automatizacionesFallidas: 0, flujosFallidos: 0, alertasCriticas: [] }
    expect(hayProblemas(base)).toBe(false)
    expect(hayProblemas({ ...base, frenados: { window_24h: 1 } })).toBe(true)
    expect(textoResumen({ ...base, rechazadosMeta: { 'error 131047': 2 }, flujosFallidos: 1 })).toContain('error 131047 (2)')
  })
})

describe('envío', () => {
  it('sin ALERTA_WHATSAPP no manda nada', async () => {
    delete process.env.ALERTA_WHATSAPP
    expect(await avisarAJulian('x')).toBe(false)
    expect(h.textos).toHaveLength(0)
  })
  it('con plantilla manda plantilla al número de Julián', async () => {
    process.env.ALERTA_PLANTILLA = 'alerta_crm'
    expect(await avisarAJulian('Línea 1\nLínea 2', 'k-plantilla')).toBe(true)
    expect(h.plantillas[0]).toMatchObject({ to: '525620714773', templateName: 'alerta_crm', params: ['Línea 1 · Línea 2'] })
    expect((h.plantillas[0].ctx as { source: string }).source).toBe('sistema')
  })
  it('no repite el mismo aviso en 30 minutos', async () => {
    await avisarAJulian('uno', 'k-repetido')
    await avisarAJulian('dos', 'k-repetido')
    expect(h.textos).toHaveLength(1)
  })
  it('si Meta lo rechaza, no lanza y deja constancia', async () => {
    h.falla = true
    expect(await avisarAJulian('x', 'k-falla')).toBe(false)
    expect(h.alertas.at(-1)).toMatchObject({ regla: 'aviso_whatsapp', accion: 'aviso_fallido' })
  })
  it('traspaso a humano: dice quién y qué escribió', async () => {
    await avisarTraspasoHumano({ accountId: 'acc-1', contactId: 'c1', conversationId: 'conv-1', texto: 'quiero hablar con una persona' })
    const t = String(h.textos[0].text)
    expect(t).toContain('Roberta')
    expect(t).toContain('+5215511112222')
    expect(t).toContain('quiero hablar con una persona')
  })
})
