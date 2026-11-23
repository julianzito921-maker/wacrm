import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Retiro de un número baneado: se avisa, se corta todo lo pendiente,
 * se apagan flujos y automatizaciones, se borran las plantillas de la
 * WABA y se libera la conexión para meter otro número.
 */

const h = vi.hoisted(() => ({
  llamadas: [] as Array<{ tabla: string; op: string; valores?: unknown }>,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      let op = 'select'
      let valores: unknown
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        in: () => b,
        insert: (v: unknown) => {
          h.llamadas.push({ tabla, op: 'insert', valores: v })
          return Promise.resolve({ error: null })
        },
        update: (v: unknown) => {
          op = 'update'
          valores = v
          return b
        },
        delete: () => {
          op = 'delete'
          return b
        },
        maybeSingle: async () => ({
          data:
            tabla === 'whatsapp_config'
              ? { id: 'cfg-1', phone_number_id: 'pn-1', waba_id: 'w-1', connected_at: null }
              : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => {
          if (op !== 'select') h.llamadas.push({ tabla, op, valores })
          resolve({
            data: tabla === 'flows' && op === 'select' ? [{ id: 'f1', status: 'active' }] : [{ id: 'x' }],
            error: null,
          })
        },
      })
      return b
    },
  }),
}))

import { diagnosticoNumero, retirarNumero } from './retiro'

beforeEach(() => {
  h.llamadas = []
})

describe('diagnóstico del número', () => {
  it('BANNED se retira y avisa', () => {
    const d = diagnosticoNumero({ status: 'BANNED', name_status: 'APPROVED' })
    expect(d.retirar).toBe(true)
    expect(d.alertas.map((a) => a.regla)).toEqual(['numero_baneado'])
  })
  it('nombre rechazado avisa pero no retira', () => {
    const d = diagnosticoNumero({ status: 'CONNECTED', name_status: 'DECLINED', verified_name: 'Aprende Y Gana' })
    expect(d.retirar).toBe(false)
    expect(d.alertas[0].regla).toBe('nombre_rechazado')
  })
  it('restringido avisa sin retirar', () => {
    const d = diagnosticoNumero({ status: 'RESTRICTED' })
    expect(d.retirar).toBe(false)
    expect(d.alertas[0].regla).toBe('numero_restringido')
  })
  it('número sano: nada', () => {
    expect(diagnosticoNumero({ status: 'CONNECTED', name_status: 'APPROVED' })).toEqual({ retirar: false, alertas: [] })
  })
})

describe('retiro del número', () => {
  it('deja ficha, corta lo pendiente, apaga y libera la conexión', async () => {
    const r = await retirarNumero('acc-1', 'prueba', { status: 'BANNED' })
    expect(r.conexionBorrada).toBe(true)
    expect(r.errores).toEqual([])
    const hechas = h.llamadas.map((l) => `${l.tabla}:${l.op}`)
    expect(hechas[0]).toBe('messaging_alerts:insert')
    expect(hechas).toEqual(
      expect.arrayContaining([
        'automation_pending_executions:update',
        'outbound_message_queue:update',
        'flow_runs:update',
        'flows:update',
        'automations:update',
        'message_templates:delete',
        'whatsapp_config:delete',
      ]),
    )
    // La conexión es lo último que se borra.
    expect(hechas[hechas.length - 1]).toBe('whatsapp_config:delete')
    // Contactos y conversaciones NO se tocan.
    expect(hechas.some((x) => x.startsWith('contacts') || x.startsWith('conversations') || x.startsWith('messages'))).toBe(false)
  })
})
