import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Vigilancia de la calidad del número (2026): amarillo avisa; rojo pausa
 * broadcasts de esa conexión, sin apagar el servicio 1:1.
 */

const h = vi.hoisted(() => ({
  calidad: 'GREEN' as string,
  alerts: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  connectionPatches: [] as Array<Record<string, unknown>>,
  connections: [
    {
      id: 'conn-1',
      account_id: 'acc-1',
      phone_number_id: 'pn-1',
      access_token: 'x',
      phone_number: '+52 1 56 1511 5142',
      display_phone_number: '+52 1 56 1511 5142',
      quality_rating: 'GREEN',
      status: 'connected',
    },
  ],
}))

vi.mock('@/lib/flows/admin-client', () => {
  const from = (tabla: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    Object.assign(b, {
      select: chain,
      eq: chain,
      in: chain,
      gte: chain,
      limit: chain,
      order: chain,
      update: (patch: Record<string, unknown>) => {
        if (tabla === 'whatsapp_connections') h.connectionPatches.push(patch)
        return b
      },
      insert: (fila: Record<string, unknown>) => {
        if (tabla === 'messaging_alerts') h.alerts.push(fila)
        if (tabla === 'notifications') h.notifications.push(fila)
        return Promise.resolve({ error: null })
      },
      upsert: () => Promise.resolve({ error: null }),
      maybeSingle: async () => ({
        data:
          tabla === 'profiles'
            ? { user_id: 'u1' }
            : tabla === 'accounts'
              ? { owner_user_id: 'u1' }
              : null,
        error: null,
      }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data:
            tabla === 'whatsapp_connections'
              ? h.connections
              : tabla === 'profiles'
                ? [{ user_id: 'u1' }]
                : tabla === 'accounts'
                  ? [{ owner_user_id: 'u1' }]
                  : [],
          error: null,
        }),
    })
    return b
  }
  return { supabaseAdmin: () => ({ from }) }
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
  h.notifications = []
  h.connectionPatches = []
})

describe('vigilancia de la calidad del número', () => {
  it('en verde no hace nada', async () => {
    const r = await revisarCalidadDeNumeros()
    expect(r[0].calidad).toBe('GREEN')
    expect(r[0].accion).toBe('nada')
    expect(h.alerts).toHaveLength(0)
  })

  it('en amarillo avisa sin apagar', async () => {
    h.calidad = 'YELLOW'
    const r = await revisarCalidadDeNumeros()
    expect(r[0].accion).toBe('avisar')
    expect(h.alerts[0].severidad).toBe('warning')
    expect(
      h.connectionPatches.some((p) => p.health_status === 'warning'),
    ).toBe(true)
  })

  it('en rojo pausa broadcasts y marca restricción', async () => {
    h.calidad = 'RED'
    const r = await revisarCalidadDeNumeros()
    expect(r[0].accion).toBe('pausar_broadcasts')
    expect(h.alerts[0].severidad).toBe('critical')
    expect(
      h.connectionPatches.some(
        (p) => p.health_status === 'restricted' && p.restriction_scope === 'mass',
      ),
    ).toBe(true)
  })

  it('si Meta no contesta, no se toca nada', async () => {
    const r = await revisarCalidadDeNumeros()
    expect(r.every((x) => x.accion === 'nada')).toBe(true)
  })
})
