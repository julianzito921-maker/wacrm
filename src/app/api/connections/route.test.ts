import { beforeEach, describe, expect, it, vi } from 'vitest'

// Registro de lo que se escribe en whatsapp_connections con service-role.
const h = vi.hoisted(() => ({
  ops: [] as { table: string; op: string; payload?: unknown; filters: Record<string, unknown> }[],
  count: 0,
}))

function builder(table: string) {
  const filters: Record<string, unknown> = {}
  let op = 'select'
  let payload: unknown
  const b: Record<string, unknown> = {}
  const registrar = () => h.ops.push({ table, op, payload, filters: { ...filters } })
  b.select = vi.fn(() => b)
  b.order = vi.fn(() => b)
  b.eq = vi.fn((k: string, v: unknown) => {
    filters[k] = v
    return b
  })
  b.neq = vi.fn(() => b)
  b.update = vi.fn((p: unknown) => {
    op = 'update'
    payload = p
    return b
  })
  b.insert = vi.fn((p: unknown) => {
    op = 'insert'
    payload = p
    return b
  })
  b.single = vi.fn(async () => {
    registrar()
    return { data: op === 'insert' ? { id: 'conn-new', ...(payload as object) } : null, error: null }
  })
  b.maybeSingle = vi.fn(async () => {
    registrar()
    return { data: null, error: null }
  })
  b.then = (resolve: (v: unknown) => unknown) => {
    registrar()
    return resolve({ data: null, error: null, count: h.count })
  }
  return b
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: 'acct-1',
    userId: 'user-1',
    supabase: { from: (t: string) => builder(t) },
  })),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: (t: string) => builder(t) }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}))

const meta = vi.hoisted(() => ({
  getPhoneNumberHealth: vi.fn(async () => ({
    display_phone_number: '+52 55 0000 0000',
    quality_rating: 'GREEN',
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
  })),
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => undefined),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { POST } from './route'

function crear(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Isla 1',
        phone_number_id: '111',
        waba_id: '222',
        access_token: 'tok',
        ...body,
      }),
    }),
  )
}

const inserts = () =>
  h.ops.filter((o) => o.table === 'whatsapp_connections' && o.op === 'insert')
const quitarDefault = () =>
  h.ops.filter(
    (o) =>
      o.table === 'whatsapp_connections' &&
      o.op === 'update' &&
      (o.payload as { is_default?: boolean }).is_default === false,
  )

beforeEach(() => {
  h.ops = []
  h.count = 0
  for (const fn of Object.values(meta)) fn.mockClear()
})

describe('POST /api/connections: emparejado con Meta', () => {
  it('suscribe la WABA a la app antes de guardar', async () => {
    const res = await crear({})
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(meta.subscribeWabaToApp).toHaveBeenCalledWith({ wabaId: '222', accessToken: 'tok' })
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled()
    expect(body).toMatchObject({ waba_subscribed: true, registered: false })
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].payload).toMatchObject({ status: 'connected', access_token: 'enc(tok)' })
  })

  it('registra el número cuando viene PIN', async () => {
    const res = await crear({ pin: '123456' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(meta.registerPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: '111',
      accessToken: 'tok',
      pin: '123456',
    })
    expect(body.registered).toBe(true)
  })

  it('rechaza un PIN que no son 6 dígitos sin llamar a Meta', async () => {
    const res = await crear({ pin: '12ab' })

    expect(res.status).toBe(400)
    expect(meta.getPhoneNumberHealth).not.toHaveBeenCalled()
    expect(inserts()).toHaveLength(0)
  })

  it('si falla la suscripción no guarda nada ni toca el default', async () => {
    meta.subscribeWabaToApp.mockRejectedValueOnce(new Error('(#200) permisos'))

    const res = await crear({ is_default: true })
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBe('meta_error')
    expect(inserts()).toHaveLength(0)
    expect(quitarDefault()).toHaveLength(0)
  })

  it('si falla /register guarda igual, desconectada, con advertencia', async () => {
    meta.registerPhoneNumber.mockRejectedValueOnce(new Error('PIN incorrecto'))

    const res = await crear({ pin: '123456' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.warning).toBe('registration_failed')
    expect(typeof body.registration_error).toBe('string')
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].payload).toMatchObject({ status: 'disconnected' })
  })

  it('sin WABA no suscribe y lo avisa', async () => {
    const res = await crear({ waba_id: '' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(body).toMatchObject({ waba_subscribed: false, warning_waba: 'missing_waba_id' })
  })
})
