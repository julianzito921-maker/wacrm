import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Los procesos proactivos (barrido de pendientes y recordatorios de
 * pago) nacen APAGADOS: son los que escriben a gente callada y los que
 * provocaron los mensajes fuera de la ventana. Se encienden cuando el
 * número esté estable.
 */

const h = vi.hoisted(() => ({
  filas: new Map<string, boolean>(),
  upserts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/flows/admin-client', () => {
  const b: Record<string, unknown> = {}
  Object.assign(b, {
    select: () => b,
    eq: (col: string, val: string) => {
      b._key = val
      return b
    },
    upsert: (fila: Record<string, unknown>) => {
      h.upserts.push(fila)
      h.filas.set(String(fila.key), Boolean(fila.valor))
      return b
    },
    maybeSingle: async () => {
      const key = String(b._key ?? '')
      return h.filas.has(key)
        ? { data: { valor: h.filas.get(key) }, error: null }
        : { data: null, error: null }
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  })
  return { supabaseAdmin: () => ({ from: () => b }) }
})

import {
  automatizacionActiva,
  barridoPendientesActivo,
  fijarFlag,
  limpiarCacheInterruptor,
  recordatoriosPagoActivos,
} from './interruptor'

beforeEach(() => {
  h.filas = new Map()
  h.upserts = []
  limpiarCacheInterruptor()
  delete process.env.WHATSAPP_AUTOMATION_ENABLED
})

describe('interruptores de procesos proactivos', () => {
  it('nacen apagados cuando no hay fila', async () => {
    expect(await barridoPendientesActivo()).toBe(false)
    expect(await recordatoriosPagoActivos()).toBe(false)
  })

  it('la automatización general nace encendida', async () => {
    expect(await automatizacionActiva()).toBe(true)
  })

  it('se pueden encender y apagar en caliente', async () => {
    await fijarFlag('barrido_pendientes_activo', true, 'prueba')
    limpiarCacheInterruptor()
    expect(await barridoPendientesActivo()).toBe(true)
    await fijarFlag('barrido_pendientes_activo', false, 'prueba')
    limpiarCacheInterruptor()
    expect(await barridoPendientesActivo()).toBe(false)
  })

  it('cada proceso tiene su propio interruptor', async () => {
    await fijarFlag('recordatorios_pago_activos', true, 'prueba')
    limpiarCacheInterruptor()
    expect(await recordatoriosPagoActivos()).toBe(true)
    expect(await barridoPendientesActivo()).toBe(false)
  })
})
