import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Ciclo del agente (Etapa 1). Lo que se prueba: el bucle de function
 * calling completo, que una herramienta desconocida no rompa nada, que
 * los argumentos se validen antes de ejecutar y que nunca se quede en
 * bucle.
 */

const h = vi.hoisted(() => ({ ejecuciones: [] as Array<{ nombre: string; args: unknown }> }))

vi.mock('./herramientas', async (importOriginal) => {
  const real = await importOriginal<typeof import('./herramientas')>()
  return {
    ...real,
    ejecutarHerramienta: async (nombre: string, args: unknown) => {
      h.ejecuciones.push({ nombre, args })
      if (nombre === 'deliver_product_bundle') {
        return { ok: true, datos: { estado: 'completa', enviados: ['pack', 'bono-abc'] } }
      }
      if (nombre === 'send_payment_details') {
        return { ok: false, datos: { error: 'no hay datos de pago configurados' } }
      }
      return { ok: true, datos: { ok: true } }
    },
  }
})

import { correrCiclo, type RespuestaModelo } from './ciclo'

const contexto = {
  accountId: 'acc',
  userId: 'user',
  conversationId: 'conv',
  contactId: 'cont',
}

beforeEach(() => {
  h.ejecuciones = []
})

describe('ciclo del agente', () => {
  it('si el modelo no pide herramientas, devuelve su texto', async () => {
    const r = await correrCiclo({
      mensajes: [{ role: 'user', content: 'hola' }],
      contexto,
      llamarModelo: async () => ({ content: ' ¡Hola! ¿Te paso la info? ' }),
    })
    expect(r.texto).toBe('¡Hola! ¿Te paso la info?')
    expect(r.ejecutadas).toEqual([])
    expect(r.vueltas).toBe(1)
  })

  it('ejecuta la herramienta y vuelve al modelo para la respuesta final', async () => {
    const respuestas: RespuestaModelo[] = [
      {
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'deliver_product_bundle', arguments: '{}' },
          },
        ],
        usage: { total_tokens: 100 },
      },
      { content: '¡Listo! Ya te mandé los cinco archivos 🎄', usage: { total_tokens: 50 } },
    ]
    let n = 0
    const r = await correrCiclo({
      mensajes: [{ role: 'user', content: 'sí, mándame el pack' }],
      contexto,
      llamarModelo: async () => respuestas[n++],
    })

    expect(h.ejecuciones).toEqual([{ nombre: 'deliver_product_bundle', args: {} }])
    expect(r.ejecutadas).toEqual([{ nombre: 'deliver_product_bundle', ok: true }])
    expect(r.texto).toContain('cinco archivos')
    expect(r.usage.total_tokens).toBe(150)
    expect(r.vueltas).toBe(2)
  })

  it('los argumentos del modelo se pasan tal cual para que la validación los juzgue', async () => {
    let n = 0
    await correrCiclo({
      mensajes: [{ role: 'user', content: 'x' }],
      contexto,
      llamarModelo: async () => {
        n += 1
        if (n === 1) {
          return {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'save_contact_state',
                  arguments: '{"estado":"HUMAN_HANDOFF"}',
                },
              },
            ],
          }
        }
        return { content: 'listo' }
      },
    })
    expect(h.ejecuciones[0]).toEqual({
      nombre: 'save_contact_state',
      args: { estado: 'HUMAN_HANDOFF' },
    })
  })

  it('si los argumentos vienen rotos, se pasan vacíos y no revienta', async () => {
    let n = 0
    const r = await correrCiclo({
      mensajes: [{ role: 'user', content: 'x' }],
      contexto,
      llamarModelo: async () => {
        n += 1
        if (n === 1) {
          return {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'mark_payment_pending', arguments: '{esto no es json' },
              },
            ],
          }
        }
        return { content: 'ok' }
      },
    })
    expect(h.ejecuciones[0].args).toEqual({})
    expect(r.texto).toBe('ok')
  })

  it('nunca se queda en bucle: corta al llegar al tope de vueltas', async () => {
    const r = await correrCiclo({
      mensajes: [{ role: 'user', content: 'x' }],
      contexto,
      llamarModelo: async () => ({
        content: 'sigo',
        tool_calls: [
          {
            id: 'c' + Math.random(),
            type: 'function',
            function: { name: 'get_contact_context', arguments: '{}' },
          },
        ],
      }),
    })
    expect(r.vueltas).toBe(4)
    expect(h.ejecuciones).toHaveLength(4)
  })

  it('una herramienta que falla se le cuenta al modelo, sin romper el ciclo', async () => {
    let n = 0
    const r = await correrCiclo({
      mensajes: [{ role: 'user', content: 'x' }],
      contexto,
      llamarModelo: async () => {
        n += 1
        if (n === 1) {
          return {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'send_payment_details', arguments: '{}' },
              },
            ],
          }
        }
        return { content: 'No tengo los datos a mano, lo revisa una persona.' }
      },
    })
    expect(r.ejecutadas).toEqual([{ nombre: 'send_payment_details', ok: false }])
    expect(r.texto).toContain('una persona')
  })
})
