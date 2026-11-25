import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  ops: [] as { op: string; payload?: unknown; filters: Record<string, unknown> }[],
  fila: {
    phone_number_id: '111',
    waba_id: '222',
    access_token: 'enc(tok-viejo)',
  } as Record<string, unknown> | null,
}))

function builder() {
  const filters: Record<string, unknown> = {}
  let op = 'select'
  let payload: unknown
  const b: Record<string, unknown> = {}
  const registrar = () => h.ops.push({ op, payload, filters: { ...filters } })
  b.select = vi.fn(() => b)
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
  b.maybeSingle = vi.fn(async () => {
    registrar()
    if (op === 'update') return { data: { id: 'conn-1', ...(payload as object) }, error: null }
    return { data: h.fila, error: null }
  })
  b.then = (resolve: (v: unknown) => unknown) => {
    registrar()
    return resolve({ data: null, error: null })
  }
  return b
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: 'acct-1',
    userId: 'user-1',
    supabase: { from: () => builder() },
  })),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => builder() }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => {
    const m = /^enc\((.*)\)$/.exec(v)
    if (!m) throw new Error('ilegible')
    return m[1]
  },
}))

const meta = vi.hoisted(() => ({
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => undefined),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { PATCH } from './route'

function editar(body: Record<string, unknown>) {
  return PATCH(
    new Request('http://localhost/api/connections/conn-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'conn-1' }) },
  )
}

const updates = () => h.ops.filter((o) => o.op === 'update')

beforeEach(() => {
  h.ops = []
  h.fila = { phone_number_id: '111', waba_id: '222', access_token: 'enc(tok-viejo)' }
  for (const fn of Object.values(meta)) fn.mockClear()
})

describe('PATCH /api/connections/[id]: re-suscripción a Meta', () => {
  it('un cambio de nombre no llama a Meta', async () => {
    const res = await editar({ name: 'Nueva' })

    expect(res.status).toBe(200)
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled()
  })

  it('el formulario reenvía la misma WABA al renombrar: no llama a Meta ni falla con token ilegible', async () => {
    // La pantalla manda waba_id en cada guardado; un token guardado ilegible
    // o un Meta caído no deben bloquear un cambio de nombre o dominio.
    h.fila = { phone_number_id: '111', waba_id: '222', access_token: 'basura' }

    const res = await editar({ name: 'Nueva', waba_id: '222', custom_domain: 'tienda.mx' })

    expect(res.status).toBe(200)
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled()
    expect(updates().at(-1)?.payload).toMatchObject({ name: 'Nueva', custom_domain: 'tienda.mx' })
    expect(updates().at(-1)?.payload).not.toHaveProperty('last_synced_at')
  })

  it('token nuevo: suscribe la WABA guardada con el token nuevo', async () => {
    const res = await editar({ access_token: 'tok-nuevo' })

    expect(res.status).toBe(200)
    expect(meta.subscribeWabaToApp).toHaveBeenCalledWith({
      wabaId: '222',
      accessToken: 'tok-nuevo',
    })
    expect(updates().at(-1)?.payload).toMatchObject({ access_token: 'enc(tok-nuevo)' })
  })

  it('WABA nueva: suscribe esa WABA con el token guardado', async () => {
    const res = await editar({ waba_id: '999' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(meta.subscribeWabaToApp).toHaveBeenCalledWith({
      wabaId: '999',
      accessToken: 'tok-viejo',
    })
    expect(body.waba_subscribed).toBe(true)
  })

  it('PIN: registra el número y lo deja conectado', async () => {
    const res = await editar({ pin: '654321' })

    expect(res.status).toBe(200)
    expect(meta.registerPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: '111',
      accessToken: 'tok-viejo',
      pin: '654321',
    })
    expect(updates().at(-1)?.payload).toMatchObject({ status: 'connected' })
  })

  it('si Meta rechaza la suscripción no guarda ni quita el default', async () => {
    meta.subscribeWabaToApp.mockRejectedValueOnce(new Error('(#100) WABA ajena'))

    const res = await editar({ waba_id: '999', is_default: true })
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBe('meta_error')
    expect(updates()).toHaveLength(0)
  })

  it('si /register falla guarda el cambio como desconectada con advertencia', async () => {
    meta.registerPhoneNumber.mockRejectedValueOnce(new Error('PIN incorrecto'))

    const res = await editar({ pin: '654321' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.warning).toBe('registration_failed')
    expect(updates().at(-1)?.payload).toMatchObject({ status: 'disconnected' })
  })

  it('token guardado ilegible y sin token nuevo: pide volver a pegarlo', async () => {
    h.fila = { phone_number_id: '111', waba_id: '222', access_token: 'basura' }

    const res = await editar({ waba_id: '999' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'token_unreadable' })
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled()
  })
})
