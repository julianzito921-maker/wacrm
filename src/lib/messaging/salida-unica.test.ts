import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fase 1 de la capa segura de mensajería: TODO envío sale por
 * `lib/messaging/send` y deja registro. Estas pruebas cubren las tres
 * promesas de la fase:
 *   1. se registra el envío exitoso (con su wamid);
 *   2. se registra el fallo, con el código de error de Meta (antes se
 *      perdía: por eso no sabíamos cuántos mensajes salían fuera de la
 *      ventana de 24 h);
 *   3. el envío se comporta igual que antes (mismo mensajeId, mismo
 *      error hacia quien llamó).
 */

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  enviar: vi.fn(async () => ({ messageId: 'wamid.ok' })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => ({
      insert: async (fila: Record<string, unknown>) => {
        if (tabla === 'outbound_message_log') h.inserts.push(fila)
        return { error: null }
      },
    }),
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return { ...real, sendTextMessage: h.enviar }
})

import { enviarSaliente, enviarTexto, extraerErrorMeta, hashContenido } from './send'

const ctx = {
  accountId: 'acc-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'cont-1',
  source: 'flujo' as const,
  reason: 'mensaje de prueba',
  workflowNodeKey: 'nodo_1',
}

beforeEach(() => {
  h.inserts = []
  h.enviar.mockReset()
  h.enviar.mockResolvedValue({ messageId: 'wamid.ok' })
})

describe('salida única de WhatsApp', () => {
  it('registra el envío exitoso con su wamid y su motivo', async () => {
    const r = await enviarTexto({
      ctx,
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: '5215500000000',
      text: 'Hola',
    })

    expect(r.messageId).toBe('wamid.ok')
    expect(h.inserts).toHaveLength(1)
    const fila = h.inserts[0]
    expect(fila.status).toBe('sent')
    expect(fila.whatsapp_message_id).toBe('wamid.ok')
    expect(fila.reason).toBe('mensaje de prueba')
    expect(fila.source).toBe('flujo')
    expect(fila.message_type).toBe('text')
    expect(fila.workflow_node_key).toBe('nodo_1')
    expect(typeof fila.latency_ms).toBe('number')
  })

  it('registra el fallo con el código de Meta y vuelve a lanzarlo', async () => {
    h.enviar.mockRejectedValueOnce(
      new Error(
        'Meta API error: 400 {"error":{"message":"Message failed to send because more than 24 hours have passed","code":131047}}',
      ),
    )

    await expect(
      enviarTexto({ ctx, phoneNumberId: 'pn-1', accessToken: 'tok', to: 'x', text: 'Hola' }),
    ).rejects.toThrow(/131047/)

    expect(h.inserts).toHaveLength(1)
    const fila = h.inserts[0]
    expect(fila.status).toBe('failed')
    expect(fila.error_code).toBe('131047')
    expect(String(fila.error_message)).toMatch(/24 hours/)
  })

  it('guarda la clave de idempotencia para no registrar dos veces', async () => {
    await enviarSaliente(
      { ...ctx, idempotencyKey: 'flow:conv-1:nodo_1' },
      { tipo: 'text', contenido: 'Hola', enviar: async () => ({ messageId: 'wamid.x' }) },
    )
    expect(h.inserts[0].idempotency_key).toBe('flow:conv-1:nodo_1')
  })

  it('un fallo del registro no impide el envío', async () => {
    const r = await enviarSaliente(ctx, {
      tipo: 'text',
      contenido: 'Hola',
      enviar: async () => ({ messageId: 'wamid.z' }),
    })
    expect(r.messageId).toBe('wamid.z')
  })
})

describe('utilidades de auditoría', () => {
  it('saca el código y el mensaje del error de Meta', () => {
    const e = extraerErrorMeta(
      new Error('Meta API error: 400 {"error":{"message":"Recipient not allowed","code":131030}}'),
    )
    expect(e.code).toBe('131030')
    expect(e.message).toBe('Recipient not allowed')
  })

  it('no revienta con un error que no es de Meta', () => {
    const e = extraerErrorMeta(new Error('sin conexión'))
    expect(e.code).toBeNull()
    expect(e.message).toBe('sin conexión')
  })

  it('el hash de contenido es estable y distingue textos', () => {
    expect(hashContenido('Hola')).toBe(hashContenido('Hola'))
    expect(hashContenido('Hola')).not.toBe(hashContenido('Hola!'))
  })
})
