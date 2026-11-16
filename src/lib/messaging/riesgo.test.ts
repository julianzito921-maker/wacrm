import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 6: ver el riesgo y frenar. Lo que se prueba: las métricas salen
 * del registro (no se inventan), el flujo que se desboca se pausa solo,
 * la relación outbound/usuario dispara el aviso y un caso crítico apaga
 * la automatización entera.
 */

const h = vi.hoisted(() => ({
  log: [] as Array<Record<string, unknown>>,
  entrantes: 0,
  updates: [] as Array<{ tabla: string; patch: Record<string, unknown> }>,
  inserts: [] as Array<{ tabla: string; filas: unknown }>,
  flag: null as boolean | null,
}))

vi.mock('@/lib/flows/admin-client', () => {
  const builder = (tabla: string) => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      gte: () => b,
      in: () => b,
      order: () => b,
      update: (patch: Record<string, unknown>) => {
        h.updates.push({ tabla, patch })
        return b
      },
      upsert: (fila: Record<string, unknown>) => {
        h.inserts.push({ tabla, filas: fila })
        if (tabla === 'messaging_flags') {
          h.flag = Boolean((fila as { valor?: boolean }).valor)
        }
        return b
      },
      insert: (filas: unknown) => {
        h.inserts.push({ tabla, filas })
        return Promise.resolve({ error: null })
      },
      maybeSingle: async () =>
        tabla === 'messaging_flags'
          ? { data: h.flag === null ? null : { valor: h.flag }, error: null }
          : { data: null, error: null },
      limit: async () =>
        tabla === 'messages'
          ? { data: Array.from({ length: h.entrantes }, () => ({ conversation_id: 'c' })), error: null }
          : { data: h.log, error: null },
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    })
    return b
  }
  return { supabaseAdmin: () => ({ from: builder }) }
})

import { metricasDeRiesgo, evaluarAlertas } from './riesgo'
import { automatizacionActiva, limpiarCacheInterruptor } from './interruptor'

const fila = (i: number, status = 'sent', conv = 'c1', flujo = 'f1', nodo = 'nodo') => ({
  conversation_id: conv,
  created_at: new Date(Date.now() - i * 60_000).toISOString(),
  status,
  workflow_id: flujo,
  workflow_node_key: nodo,
})

beforeEach(() => {
  h.log = []
  h.entrantes = 0
  h.updates = []
  h.inserts = []
  h.flag = null
  limpiarCacheInterruptor()
  delete process.env.WHATSAPP_AUTOMATION_ENABLED
})

describe('métricas de riesgo', () => {
  it('cuenta enviados, frenados y la relación outbound/usuario', async () => {
    h.log = [fila(1), fila(2), fila(3, 'blocked'), fila(4, 'failed')]
    h.entrantes = 2
    const m = await metricasDeRiesgo('acc', 24)
    expect(m.enviados).toBe(2)
    expect(m.frenados).toBe(1)
    expect(m.fallidos).toBe(1)
    expect(m.outboundPorUsuario).toBe(1)
  })

  it('detecta la racha máxima de mensajes seguidos', async () => {
    h.log = Array.from({ length: 9 }, (_, i) => fila(i + 1))
    const m = await metricasDeRiesgo('acc', 24)
    expect(m.seguidosMax).toBe(9)
    expect(m.conversacionesConMasDe6).toBe(1)
  })
})

describe('alertas', () => {
  it('avisa cuando hay una racha larga', async () => {
    h.log = Array.from({ length: 8 }, (_, i) => fila(i + 1))
    const alertas = await evaluarAlertas('acc')
    expect(alertas.map((a) => a.regla)).toContain('racha_seguida')
    expect(h.inserts.some((x) => x.tabla === 'messaging_alerts')).toBe(true)
  })

  it('pausa solo el flujo que concentra el envío', async () => {
    h.log = [
      ...Array.from({ length: 25 }, (_, i) => fila(i + 1, 'sent', 'c1', 'flujo-malo')),
      ...Array.from({ length: 2 }, (_, i) => fila(i + 1, 'sent', 'c2', 'flujo-bueno')),
    ]
    const alertas = await evaluarAlertas('acc')
    const pausa = h.updates.find((u) => u.tabla === 'flows')
    expect(pausa?.patch.status).toBe('draft')
    expect(String(pausa?.patch.auto_pause_reason)).toContain('25')
    expect(alertas.some((a) => a.accion === 'flujo_pausado')).toBe(true)
  })

  it('apaga la automatización entera en un caso crítico', async () => {
    h.log = Array.from({ length: 40 }, (_, i) => fila(i + 1, 'sent', `c${i}`))
    h.entrantes = 1 // ratio 40 → muy por encima del umbral crítico
    const alertas = await evaluarAlertas('acc')
    expect(alertas.some((a) => a.accion === 'automatizacion_apagada')).toBe(true)
    expect(h.flag).toBe(false)
    expect(await automatizacionActiva()).toBe(false)
  })
})

describe('interruptor de emergencia', () => {
  it('el entorno puede apagarlo sin tocar la base', async () => {
    process.env.WHATSAPP_AUTOMATION_ENABLED = 'false'
    expect(await automatizacionActiva()).toBe(false)
  })

  it('la base puede apagarlo en caliente', async () => {
    h.flag = false
    expect(await automatizacionActiva()).toBe(false)
  })
})
