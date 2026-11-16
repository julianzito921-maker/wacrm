import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 3: estado de conversación, bloqueo, traspaso a humano y baja
 * voluntaria. Lo que se prueba aquí es lo que evita dos de las causas
 * de bloqueo de número: escribirle a quien pidió que no le escribamos y
 * seguir automatizando cuando ya hay una persona al mando.
 */

const h = vi.hoisted(() => ({
  estado: 'ACTIVE' as string | null,
  optOut: null as string | null,
  bloqueoLibre: true,
  updates: [] as Array<{ tabla: string; patch: Record<string, unknown> }>,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    function builder(tabla: string) {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        update: (patch: Record<string, unknown>) => {
          h.updates.push({ tabla, patch })
          return b
        },
        or: () => b,
        // tomarConversacion termina en .select('id') tras el .or()
        then: undefined,
        upsert: async () => ({ error: null }),
        delete: () => b,
        maybeSingle: async () =>
          tabla === 'conversations'
            ? { data: h.estado === null ? null : { state: h.estado }, error: null }
            : { data: { opt_out_at: h.optOut }, error: null },
      })
      // `.or(...).select('id')` debe resolverse a filas: se simula con un
      // objeto que resuelve según el bloqueo.
      const originalSelect = b.select as () => unknown
      b.select = () => {
        const siguiente = originalSelect()
        if (tabla === 'conversations' && siguiente === b) {
          return Object.assign(b, {
            select: () => b,
            eq: () => b,
            or: () => b,
          })
        }
        return siguiente
      }
      return b
    }
    return {
      from: (tabla: string) => {
        const b = builder(tabla)
        // El update condicional del bloqueo devuelve filas si estaba libre.
        const originalOr = b.or as () => unknown
        b.or = () => {
          originalOr()
          return {
            select: async () =>
              h.bloqueoLibre ? { data: [{ id: 'conv-1' }] } : { data: [] },
          }
        }
        return b
      },
    }
  },
}))

import { admiteAutomatico, estadoPorEntrante, pideBaja, pideHumano, tomarConversacion } from './estado'

beforeEach(() => {
  h.estado = 'ACTIVE'
  h.optOut = null
  h.bloqueoLibre = true
  h.updates = []
})

describe('detección de señales sensibles', () => {
  it('reconoce las peticiones de hablar con una persona', () => {
    for (const t of [
      'quiero hablar con una persona',
      'me pasas con un asesor?',
      'necesito un humano',
      'AGENTE por favor',
    ]) {
      expect(pideHumano(t)).toBe(true)
    }
  })

  it('reconoce las bajas voluntarias', () => {
    for (const t of ['no me escribas', 'STOP', 'baja', 'ya no quiero', 'deja de escribirme']) {
      expect(pideBaja(t)).toBe(true)
    }
  })

  it('no confunde un «no» normal con una baja', () => {
    for (const t of [
      'no sé tejer todavía',
      'no gracias, luego',
      'no me llegó el archivo',
      'no entiendo el paso 3',
    ]) {
      expect(pideBaja(t)).toBe(false)
    }
  })
})

describe('estados que admiten automatización', () => {
  it('sólo se aparta con humano, baja, pausa o cerrada', () => {
    expect(admiteAutomatico('ACTIVE')).toBe(true)
    expect(admiteAutomatico('WAITING_USER')).toBe(true)
    expect(admiteAutomatico('NEW')).toBe(true)
    expect(admiteAutomatico('HUMAN_HANDOFF')).toBe(false)
    expect(admiteAutomatico('OPT_OUT')).toBe(false)
    expect(admiteAutomatico('PAUSED')).toBe(false)
    expect(admiteAutomatico('CLOSED')).toBe(false)
  })
})

describe('estado al escribir la clienta', () => {
  it('marca baja voluntaria y deja el contacto en opt-out', async () => {
    const r = await estadoPorEntrante({
      accountId: 'acc',
      conversationId: 'conv-1',
      contactId: 'cont-1',
      texto: 'no me escribas más',
    })
    expect(r.bajo).toBe(true)
    expect(r.estado).toBe('OPT_OUT')
    expect(h.updates.some((u) => u.tabla === 'contacts' && u.patch.opt_out_at)).toBe(true)
    expect(h.updates.some((u) => u.tabla === 'conversations' && u.patch.state === 'OPT_OUT')).toBe(true)
  })

  it('marca traspaso a humano cuando lo piden', async () => {
    const r = await estadoPorEntrante({
      accountId: 'acc',
      conversationId: 'conv-1',
      contactId: 'cont-1',
      texto: 'quiero hablar con una persona',
    })
    expect(r.humano).toBe(true)
    expect(h.updates.some((u) => u.tabla === 'conversations' && u.patch.state === 'HUMAN_HANDOFF')).toBe(true)
  })

  it('un mensaje normal deja la conversación esperando respuesta', async () => {
    const r = await estadoPorEntrante({
      accountId: 'acc',
      conversationId: 'conv-1',
      contactId: 'cont-1',
      texto: 'hola, cuánto cuesta?',
    })
    expect(r.estado).toBe('WAITING_AI')
  })

  it('si vuelve a escribir tras una baja, se reabre la conversación', async () => {
    h.estado = 'OPT_OUT'
    const r = await estadoPorEntrante({
      accountId: 'acc',
      conversationId: 'conv-1',
      contactId: 'cont-1',
      texto: 'hola de nuevo',
    })
    expect(r.estado).toBe('WAITING_AI')
    expect(h.updates.some((u) => u.tabla === 'contacts' && u.patch.opt_out_at === null)).toBe(true)
  })
})

describe('bloqueo por conversación', () => {
  it('lo consigue quien lo encuentra libre', async () => {
    expect(await tomarConversacion('conv-1', 'webhook-A')).toBe(true)
  })

  it('lo pierde quien llega segundo', async () => {
    h.bloqueoLibre = false
    expect(await tomarConversacion('conv-1', 'webhook-B')).toBe(false)
  })
})
