import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 2: la política decide si un mensaje puede salir. Estas pruebas
 * cubren las reglas que evitan el baneo: ventana de 24 h, duplicados,
 * límites y mensajes seguidos sin respuesta de la clienta.
 */

const h = vi.hoisted(() => ({
  lastInboundAt: null as string | null,
  estado: 'ACTIVE' as string,
  optOut: null as string | null,
  previos: [] as Array<{ created_at: string; content_hash: string | null }>,
  inserts: [] as Record<string, unknown>[],
  enviar: vi.fn(async () => ({ messageId: 'wamid.ok' })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const logBuilder: Record<string, unknown> = {}
    Object.assign(logBuilder, {
      select: () => logBuilder,
      eq: () => logBuilder,
      in: () => logBuilder,
      gte: () => logBuilder,
      order: () => logBuilder,
      limit: async () => ({ data: h.previos, error: null }),
    })
    const convBuilder: Record<string, unknown> = {}
    Object.assign(convBuilder, {
      select: () => convBuilder,
      eq: () => convBuilder,
      maybeSingle: async () => ({
        data: { last_inbound_at: h.lastInboundAt, state: h.estado },
        error: null,
      }),
    })
    const contactBuilder: Record<string, unknown> = {}
    Object.assign(contactBuilder, {
      select: () => contactBuilder,
      eq: () => contactBuilder,
      maybeSingle: async () => ({ data: { opt_out_at: h.optOut }, error: null }),
    })
    return {
      from: (tabla: string) => ({
        ...(tabla === 'conversations'
          ? convBuilder
          : tabla === 'contacts'
            ? contactBuilder
            : logBuilder),
        insert: async (fila: Record<string, unknown>) => {
          h.inserts.push(fila)
          return { error: null }
        },
      }),
    }
  },
}))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return { ...real, sendTextMessage: h.enviar, sendTemplateMessage: h.enviar }
})

import { decidirSalida, TOPES } from './politica'
import { enviarSaliente, enviarTexto, enviarPlantilla, EnvioBloqueadoError } from './send'

const ctx = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'cont-1',
  source: 'flujo' as const,
  reason: 'prueba',
}

const haceMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

beforeEach(() => {
  h.lastInboundAt = new Date().toISOString()
  h.estado = 'ACTIVE'
  h.optOut = null
  h.previos = []
  h.inserts = []
  h.enviar.mockReset()
  h.enviar.mockResolvedValue({ messageId: 'wamid.ok' })
  delete process.env.WHATSAPP_SAFETY_ENFORCE
  delete process.env.WHATSAPP_AUTOMATION_ENABLED
})

afterEach(() => {
  delete process.env.SAFETY_MAX_CONSECUTIVE
  delete process.env.SAFETY_MAX_PER_MINUTE
})

describe('ventana de 24 horas', () => {
  it('deja pasar texto libre dentro de la ventana', async () => {
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'Hola' })
    expect(d.permitido).toBe(true)
  })

  it('frena el texto libre cuando la clienta lleva más de 24 h callada', async () => {
    h.lastInboundAt = haceMin(29 * 60)
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'Hola' })
    expect(d.permitido).toBe(false)
    expect(d.motivo).toBe('window_24h')
  })

  it('frena también si la clienta nunca escribió', async () => {
    h.lastInboundAt = null
    const d = await decidirSalida({ ctx, tipo: 'image', contenido: 'foto' })
    expect(d.motivo).toBe('window_24h')
  })

  it('la plantilla sí puede salir fuera de la ventana', async () => {
    h.lastInboundAt = haceMin(72 * 60)
    const d = await decidirSalida({ ctx, tipo: 'template', contenido: 'promo' })
    expect(d.permitido).toBe(true)
  })
})

describe('duplicados y límites', () => {
  it('frena el mismo contenido repetido dentro de la ventana de deduplicación', async () => {
    h.previos = [{ created_at: haceMin(2), content_hash: 'abc-3' }]
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'abc', hash: 'abc-3' })
    expect(d.motivo).toBe('duplicate')
  })

  it('frena cuando hay demasiados mensajes seguidos sin respuesta', async () => {
    process.env.SAFETY_MAX_CONSECUTIVE = '3'
    h.lastInboundAt = haceMin(30)
    h.previos = [0, 1, 2].map((i) => ({ created_at: haceMin(10 + i), content_hash: `h${i}` }))
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'otro' })
    expect(d.motivo).toBe('too_many_consecutive')
  })

  it('no cuenta los mensajes anteriores a la última respuesta de la clienta', async () => {
    process.env.SAFETY_MAX_CONSECUTIVE = '3'
    h.lastInboundAt = haceMin(1)
    h.previos = [0, 1, 2].map((i) => ({ created_at: haceMin(5 + i), content_hash: `h${i}` }))
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'nuevo' })
    expect(d.permitido).toBe(true)
  })

  it('frena al pasar el tope por minuto', async () => {
    process.env.SAFETY_MAX_PER_MINUTE = '2'
    h.previos = [0, 1].map((i) => ({ created_at: haceMin(0), content_hash: `h${i}` }))
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'x' })
    expect(d.motivo).toBe('limit_per_minute')
  })
})

describe('interruptor de emergencia', () => {
  it('apaga lo automático pero deja pasar lo que manda una persona', async () => {
    process.env.WHATSAPP_AUTOMATION_ENABLED = 'false'
    const auto = await decidirSalida({ ctx, tipo: 'text', contenido: 'x' })
    expect(auto.motivo).toBe('automation_disabled')
    const manual = await decidirSalida({
      ctx: { ...ctx, source: 'manual' },
      tipo: 'text',
      contenido: 'x',
    })
    expect(manual.permitido).toBe(true)
  })
})

describe('modo observación', () => {
  it('no bloquea, pero deja registrada la regla que habría frenado', async () => {
    process.env.WHATSAPP_SAFETY_ENFORCE = 'false'
    h.lastInboundAt = haceMin(48 * 60)
    const r = await enviarTexto({
      ctx,
      phoneNumberId: 'pn',
      accessToken: 'tok',
      to: '52155',
      text: 'Hola',
    })
    expect(r.messageId).toBe('wamid.ok')
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].blocked_reason).toBe('window_24h')
    expect(h.inserts[0].dry_run).toBe(true)
  })
})

describe('envío bloqueado de verdad', () => {
  it('no llama a Meta, lanza EnvioBloqueadoError y deja la huella', async () => {
    h.lastInboundAt = haceMin(48 * 60)
    await expect(
      enviarSaliente(ctx, {
        tipo: 'text',
        contenido: 'Hola',
        enviar: async () => ({ messageId: 'wamid.nunca' }),
      }),
    ).rejects.toBeInstanceOf(EnvioBloqueadoError)
    expect(h.enviar).not.toHaveBeenCalled()
    expect(h.inserts[0].status).toBe('blocked')
    expect(h.inserts[0].blocked_reason).toBe('window_24h')
  })

  it('la plantilla sale aunque estemos fuera de la ventana', async () => {
    h.lastInboundAt = haceMin(48 * 60)
    const r = await enviarPlantilla({
      ctx,
      phoneNumberId: 'pn',
      accessToken: 'tok',
      to: '52155',
      templateName: 'promo',
      language: 'es_MX',
    })
    expect(r.messageId).toBe('wamid.ok')
  })

  it('los topes tienen valores por defecto sensatos', () => {
    expect(TOPES.maxSeguidos()).toBe(8)
    expect(TOPES.ventanaHoras()).toBe(23.5)
    expect(TOPES.dupMinutos()).toBe(10)
  })
})

describe('estado de la conversación y baja voluntaria', () => {
  it('no automatiza si la conversación está en manos de una persona', async () => {
    h.estado = 'HUMAN_HANDOFF'
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'Hola' })
    expect(d.permitido).toBe(false)
    expect(d.motivo).toBe('state_blocked')
  })

  it('no automatiza si la clienta pidió que no le escribamos', async () => {
    h.estado = 'OPT_OUT'
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'Hola' })
    expect(d.motivo).toBe('opt_out')
  })

  it('también frena si la baja está anotada en el contacto', async () => {
    h.optOut = new Date().toISOString()
    const d = await decidirSalida({ ctx, tipo: 'text', contenido: 'Hola' })
    expect(d.motivo).toBe('opt_out')
  })

  it('una persona puede escribir aunque la conversación esté en traspaso', async () => {
    h.estado = 'HUMAN_HANDOFF'
    const d = await decidirSalida({
      ctx: { ...ctx, source: 'manual' },
      tipo: 'text',
      contenido: 'Hola, te atiendo yo',
    })
    expect(d.permitido).toBe(true)
  })
})
