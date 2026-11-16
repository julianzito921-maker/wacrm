import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 4: cola de salida. Lo que se prueba es lo que evita perder
 * mensajes sin duplicarlos: reintento con espera creciente, tope de
 * intentos, nada de reintentar un rechazo de política, y cancelación de
 * lo que ya no tiene sentido.
 */

const h = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ patch: Record<string, unknown> }>,
  encoladas: [] as Array<Record<string, unknown>>,
  enviarTexto: vi.fn(),
  enviarMedio: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => {
  const builder = (tabla: string) => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      gte: () => b,
      order: () => b,
      limit: () => b,
      update: (patch: Record<string, unknown>) => {
        h.updates.push({ patch })
        return b
      },
      upsert: (fila: Record<string, unknown>) => {
        h.encoladas.push(fila)
        return b
      },
      // El builder se puede esperar: eso cubre `.upsert(...).select('id')`.
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'q-1' }], error: null }),
      maybeSingle: async () =>
        tabla === 'contacts'
          ? { data: { id: 'cont-1', phone: '5215500000000', wa_user_id: null }, error: null }
          : { data: { state: 'ACTIVE', last_inbound_at: new Date().toISOString() }, error: null },
    })
    return b
  }
  return {
    supabaseAdmin: () => ({
      from: builder,
      rpc: async () => ({ data: h.filas, error: null }),
    }),
  }
})

vi.mock('@/lib/flows/meta-send', () => ({
  loadAccountMetaCredentials: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}))

vi.mock('@/lib/whatsapp/wa-identity', () => ({
  resolveContactSendTarget: () => ({ target: '5215500000000', isPhone: true }),
}))

vi.mock('./send', async (importOriginal) => {
  const real = await importOriginal<typeof import('./send')>()
  return { ...real, enviarTexto: h.enviarTexto, enviarMedio: h.enviarMedio }
})

import { EnvioBloqueadoError } from './send'
import { esperaReintento, esReintentable, procesarLote } from './cola'
import { insertarEnCola } from './cola-store'

const filaBase = {
  id: 'q-1',
  account_id: 'acc-1',
  conversation_id: 'conv-1',
  contact_id: 'cont-1',
  message_type: 'text',
  payload: { text: 'Hola' },
  reason: 'prueba',
  source: 'flujo',
  workflow_id: null,
  workflow_node_key: null,
  source_event_id: null,
  idempotency_key: 'k-1',
  attempt_number: 1,
  max_attempts: 3,
}

beforeEach(() => {
  h.filas = [{ ...filaBase }]
  h.updates = []
  h.encoladas = []
  h.enviarTexto.mockReset()
  h.enviarMedio.mockReset()
})

describe('reintentabilidad y espera', () => {
  it('reintenta lo temporal y no lo que Meta rechaza por política', () => {
    expect(esReintentable(new Error('Meta API error: 503 Service Unavailable'))).toBe(true)
    expect(esReintentable(new Error('Meta API error: 429 Too Many Requests'))).toBe(true)
    expect(esReintentable(new Error('fetch failed'))).toBe(true)
    expect(
      esReintentable(new Error('Meta API error: 400 {"error":{"code":131047}}')),
    ).toBe(false)
  })

  it('la espera crece y se queda topada', () => {
    expect(esperaReintento(1)).toBe(30_000)
    expect(esperaReintento(2)).toBe(120_000)
    expect(esperaReintento(3)).toBe(600_000)
    expect(esperaReintento(9)).toBe(600_000)
  })
})

describe('encolar', () => {
  it('encola con la clave de idempotencia', async () => {
    const id = await insertarEnCola({
      account_id: 'acc-1',
      conversation_id: 'conv-1',
      contact_id: 'cont-1',
      message_type: 'text',
      payload: { text: 'Hola' },
      source: 'flujo',
      idempotency_key: 'k-1',
    })
    expect(id).toBe('q-1')
    expect(h.encoladas[0].idempotency_key).toBe('k-1')
  })
})

describe('procesar el lote', () => {
  it('marca enviado cuando sale', async () => {
    h.enviarTexto.mockResolvedValueOnce({ messageId: 'wamid.ok' })
    const r = await procesarLote(10)
    expect(r.enviados).toBe(1)
    expect(h.updates[0].patch.status).toBe('SENT')
    expect(h.updates[0].patch.whatsapp_message_id).toBe('wamid.ok')
  })

  it('reprograma el fallo temporal con espera', async () => {
    h.enviarTexto.mockRejectedValueOnce(new Error('Meta API error: 503'))
    const r = await procesarLote(10)
    expect(r.reprogramados).toBe(1)
    expect(h.updates[0].patch.status).toBe('PENDING')
    expect(h.updates[0].patch.next_retry_at).toBeTruthy()
  })

  it('deja de reintentar al agotar los intentos', async () => {
    h.filas = [{ ...filaBase, attempt_number: 3, max_attempts: 3 }]
    h.enviarTexto.mockRejectedValueOnce(new Error('Meta API error: 500'))
    const r = await procesarLote(10)
    expect(r.fallidos).toBe(1)
    expect(h.updates[0].patch.status).toBe('FAILED')
  })

  it('no reintenta un rechazo de política: lo cancela', async () => {
    h.enviarTexto.mockRejectedValueOnce(new EnvioBloqueadoError('window_24h', 'fuera de ventana'))
    const r = await procesarLote(10)
    expect(r.cancelados).toBe(1)
    expect(h.updates[0].patch.status).toBe('CANCELLED')
    expect(h.updates[0].patch.cancel_reason).toBe('window_24h')
  })

  it('no reintenta un 4xx de Meta', async () => {
    h.enviarTexto.mockRejectedValueOnce(new Error('Meta API error: 400 recipient invalid'))
    const r = await procesarLote(10)
    expect(r.fallidos).toBe(1)
  })
})
