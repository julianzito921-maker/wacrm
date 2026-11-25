import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./meta-api', () => ({
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
}))

import { sincronizarConexionDesdeConfig } from './conexion-meta'

let filas: Array<Record<string, unknown>> = []
/** Conversaciones de la cuenta (para el chequeo de hilos legados). */
let conversaciones: Array<Record<string, unknown>> = []
let escrituras: { op: string; payload: unknown; eq: Record<string, unknown> }[] = []

function fakeDb() {
  return {
    from(tabla: string) {
      const eq: Record<string, unknown> = {}
      let op = 'select'
      let payload: unknown
      const lista = () =>
        (tabla === 'conversations' ? conversaciones : filas).filter((r) =>
          Object.entries(eq).every(([k, v]) => (r[k] ?? null) === v),
        )
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (k: string, v: unknown) => {
        eq[k] = v
        return b
      }
      b.is = (k: string, v: unknown) => {
        eq[k] = v
        return b
      }
      b.limit = () => b
      b.update = (p: unknown) => {
        op = 'update'
        payload = p
        return b
      }
      b.insert = (p: unknown) => {
        escrituras.push({ op: 'insert', payload: p, eq: {} })
        return { select: () => ({ maybeSingle: async () => ({ data: { id: 'conn-new' }, error: null }) }) }
      }
      b.maybeSingle = async () => ({ data: lista()[0] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (op === 'update') {
          escrituras.push({ op, payload, eq: { ...eq } })
          return resolve({ data: null, error: null })
        }
        return resolve({ data: lista(), error: null })
      }
      return b
    },
  }
}

const base = {
  accountId: 'acc-1',
  phoneNumberId: '999',
  phoneNumberIdAnterior: '111',
  wabaId: 'W',
  accessTokenCifrado: 'enc',
  verifyTokenCifrado: null,
  status: 'connected' as const,
  displayPhoneNumber: null,
}

beforeEach(() => {
  filas = []
  conversaciones = []
  escrituras = []
})

describe('sincronizarConexionDesdeConfig', () => {
  it('el número nuevo hereda el default del número que reemplaza', async () => {
    filas = [{ id: 'conn-viejo', account_id: 'acc-1', phone_number_id: '111', is_default: true }]

    const r = await sincronizarConexionDesdeConfig(fakeDb() as never, base)

    expect(r).toEqual({ ok: true, connectionId: 'conn-new' })
    expect(escrituras[0]).toMatchObject({ op: 'update', payload: { is_default: false }, eq: { id: 'conn-viejo' } })
    expect(escrituras[1]).toMatchObject({ op: 'insert', payload: { is_default: true, phone_number_id: '999' } })
  })

  it('no le quita el default a otra isla que no se está reemplazando', async () => {
    filas = [{ id: 'conn-otra', account_id: 'acc-1', phone_number_id: '555', is_default: true }]

    await sincronizarConexionDesdeConfig(fakeDb() as never, base)

    expect(escrituras).toHaveLength(1)
    expect(escrituras[0]).toMatchObject({ op: 'insert', payload: { is_default: false } })
  })

  it('no crea la conexión si la cuenta ya tiene hilos sin conexión (no parte el historial)', async () => {
    // Hilos abiertos por el respaldo de whatsapp_config: si se creara la
    // conexión, el webhook abriría un hilo nuevo por cada clienta.
    conversaciones = [{ id: 'conv-1', account_id: 'acc-1', connection_id: null }]
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await sincronizarConexionDesdeConfig(fakeDb() as never, base)

    expect(r).toEqual({ ok: false, error: 'legacy_threads_without_connection' })
    expect(escrituras).toHaveLength(0)
    errores.mockRestore()
  })

  it('los hilos que ya tienen conexión no frenan el alta', async () => {
    conversaciones = [{ id: 'conv-1', account_id: 'acc-1', connection_id: 'conn-viejo' }]

    const r = await sincronizarConexionDesdeConfig(fakeDb() as never, base)

    expect(r).toEqual({ ok: true, connectionId: 'conn-new' })
  })

  it('no toca una conexión de otra cuenta', async () => {
    filas = [{ id: 'conn-x', account_id: 'otra', phone_number_id: '999' }]
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await sincronizarConexionDesdeConfig(fakeDb() as never, base)

    expect(r.ok).toBe(false)
    expect(escrituras).toHaveLength(0)
    errores.mockRestore()
  })
})
