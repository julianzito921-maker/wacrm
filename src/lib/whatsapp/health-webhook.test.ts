import { beforeEach, describe, expect, it, vi } from 'vitest'

// El módulo importa el cliente service-role por defecto; aquí siempre se
// inyecta `db`, así que basta con que no intente conectarse.
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { handleHealthWebhookChange } from './health-webhook'

interface Llamada {
  table: string
  op: string
  payload?: unknown
  eq: Record<string, unknown>
  in: Record<string, unknown[]>
}

let llamadas: Llamada[] = []
let conexiones: Array<Record<string, unknown>> = []
let plantillas: Array<Record<string, unknown>> = []
let broadcastsPausados: Array<{ id: string }> = []

function fakeDb() {
  return {
    from(table: string) {
      const c: Llamada = { table, op: 'select', eq: {}, in: {} }
      llamadas.push(c)
      const resultado = () => {
        if (table === 'whatsapp_connections') {
          return conexiones.filter((r) => r.waba_id === c.eq.waba_id)
        }
        if (table === 'message_templates' && c.op === 'select') {
          return plantillas.filter(
            (r) =>
              Object.entries(c.eq).every(([k, v]) => r[k] === v) &&
              Object.entries(c.in).every(([k, v]) => v.includes(r[k])),
          )
        }
        if (table === 'broadcasts' && c.op === 'update') return broadcastsPausados
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (k: string, v: unknown) => {
        c.eq[k] = v
        return b
      }
      b.in = (k: string, v: unknown[]) => {
        c.in[k] = v
        return b
      }
      b.gte = () => b
      b.limit = () => b
      b.or = () => {
        throw new Error('no debe filtrar plantillas con or() sin cuenta')
      }
      b.maybeSingle = () => {
        throw new Error('no debe usar maybeSingle con varias filas posibles')
      }
      b.update = (p: unknown) => {
        c.op = 'update'
        c.payload = p
        return b
      }
      b.insert = (p: unknown) => {
        c.op = 'insert'
        c.payload = p
        return Promise.resolve({ data: null, error: null })
      }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: resultado(), error: null })
      return b
    },
  }
}

const pausas = () => llamadas.filter((c) => c.table === 'broadcasts' && c.op === 'update')

beforeEach(() => {
  llamadas = []
  conexiones = [{ id: 'conn-1', account_id: 'acc-1', waba_id: 'WABA-1' }]
  plantillas = []
  broadcastsPausados = []
})

async function calidad(value: Record<string, unknown>) {
  await handleHealthWebhookChange({
    field: 'message_template_quality_update',
    value,
    wabaId: 'WABA-1',
    db: fakeDb() as never,
  })
}

describe('message_template_quality_update (salud)', () => {
  it('lee new_quality_score: RED pausa los broadcasts de la cuenta de la WABA', async () => {
    plantillas = [
      { account_id: 'acc-1', name: 'promo', meta_template_id: '77' },
      // Misma plantilla en otra cuenta: no se toca.
      { account_id: 'acc-otra', name: 'promo', meta_template_id: '77' },
    ]
    broadcastsPausados = [{ id: 'b1' }]

    await calidad({ message_template_id: 77, message_template_name: 'promo', new_quality_score: 'RED' })

    expect(pausas()).toHaveLength(1)
    expect(pausas()[0].eq).toMatchObject({ account_id: 'acc-1', template_name: 'promo' })
    const lectura = llamadas.find((c) => c.table === 'message_templates')!
    expect(lectura.in.account_id).toEqual(['acc-1'])
  })

  it('no escribe quality_score (eso es de template-webhook)', async () => {
    plantillas = [{ account_id: 'acc-1', name: 'promo', meta_template_id: '77' }]

    await calidad({ message_template_id: 77, new_quality_score: 'YELLOW' })

    expect(
      llamadas.filter((c) => c.table === 'message_templates' && c.op === 'update'),
    ).toHaveLength(0)
    expect(pausas()).toHaveLength(0)
  })

  it('GREEN o YELLOW no pausan nada', async () => {
    plantillas = [{ account_id: 'acc-1', name: 'promo', meta_template_id: '77' }]
    await calidad({ message_template_id: 77, new_quality_score: 'GREEN' })
    expect(pausas()).toHaveLength(0)
  })

  it('varias filas de la misma plantilla (varios idiomas) no rompen: una pausa por nombre', async () => {
    plantillas = [
      { account_id: 'acc-1', name: 'promo', meta_template_id: '77', language: 'es_MX' },
      { account_id: 'acc-1', name: 'promo', meta_template_id: '77', language: 'en_US' },
    ]
    await calidad({ message_template_id: 77, new_quality_score: 'RED' })
    expect(pausas()).toHaveLength(1)
  })

  it('sin fila local, pausa por el nombre que trae Meta en las cuentas de la WABA', async () => {
    await calidad({ message_template_id: 99, message_template_name: 'nueva', new_quality_score: 'RED' })
    expect(pausas()).toHaveLength(1)
    expect(pausas()[0].eq).toMatchObject({ account_id: 'acc-1', template_name: 'nueva' })
  })
})
