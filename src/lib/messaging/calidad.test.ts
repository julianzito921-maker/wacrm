import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Vigilancia de la calidad del número: es el único aviso que da Meta antes
 * de restringir. Amarillo avisa; rojo apaga la automatización sola.
 */

const h = vi.hoisted(() => ({
  calidad: 'GREEN' as string,
  alerts: [] as Array<Record<string, unknown>>,
  flags: [] as Array<{ valor: boolean; reason: string }>,
  configs: [
    {
      account_id: 'acc-1',
      phone_number_id: 'pn-1',
      access_token: 'x',
      status: 'connected',
    },
  ],
}))

vi.mock('@/lib/flows/admin-client', () => {
  const b: Record<string, unknown> = {}
  Object.assign(b, {
    select: () => b,
    eq: () => b,
    insert: (fila: Record<string, unknown>) => {
      h.alerts.push(fila)
      return Promise.resolve({ error: null })
    },
    upsert: (fila: { valor?: boolean; reason?: string }) => {
      h.flags.push({ valor: Boolean(fila.valor), reason: fila.reason ?? '' })
      return b
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: h.configs, error: null }),
  })
  return { supabaseAdmin: () => ({ from: () => b }) }
})

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (x: string) => x }))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getPhoneNumberHealth: async () => ({
    id: 'pn-1',
    display_phone_number: '+52 1 56 1511 5142',
    quality_rating: h.calidad,
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
  }),
}))

import { revisarCalidadDeNumeros } from './calidad'

beforeEach(() => {
  h.calidad = 'GREEN'
  h.alerts = []
  h.flags = []
})

describe('vigilancia de la calidad del número', () => {
  it('en verde no hace nada', async () => {
    const r = await revisarCalidadDeNumeros()
    expect(r[0].calidad).toBe('GREEN')
    expect(r[0].accion).toBe('nada')
    expect(h.alerts).toHaveLength(0)
    expect(h.flags).toHaveLength(0)
  })

  it('en amarillo avisa sin apagar', async () => {
    h.calidad = 'YELLOW'
    const r = await revisarCalidadDeNumeros()
    expect(r[0].accion).toBe('avisar')
    expect(h.alerts[0].severidad).toBe('warning')
    expect(h.flags).toHaveLength(0)
  })

  it('en rojo avisa y apaga la automatización', async () => {
    h.calidad = 'RED'
    const r = await revisarCalidadDeNumeros()
    expect(r[0].accion).toBe('apagar')
    expect(h.alerts[0].severidad).toBe('critical')
    expect(h.flags[0].valor).toBe(false)
    expect(h.flags[0].reason).toContain('rojo')
  })

  it('si Meta no contesta, no se toca nada', async () => {
    h.calidad = 'GREEN'
    h.flags = []
    // Con cualquier respuesta, sin calidad reportada, no se apaga nada.
    const r = await revisarCalidadDeNumeros()
    expect(h.flags).toHaveLength(0)
    expect(r.every((x) => x.accion === 'nada')).toBe(true)
  })
})
