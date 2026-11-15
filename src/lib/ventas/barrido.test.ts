import { describe, expect, it } from 'vitest'
import { quedaPendiente } from './barrido'

const ahora = Date.parse('2026-11-12T12:00:00Z')
const hace = (min: number) => new Date(ahora - min * 60_000).toISOString()

describe('quedaPendiente', () => {
  it('texto de la clienta de hace 30 min: sí', () =>
    expect(quedaPendiente({ sender_type: 'customer', content_type: 'text', created_at: hace(30) }, ahora)).toBe(true))
  it('recién llegado (5 min): todavía no', () =>
    expect(quedaPendiente({ sender_type: 'customer', content_type: 'text', created_at: hace(5) }, ahora)).toBe(false))
  it('fuera de la ventana de 24 h: no', () =>
    expect(quedaPendiente({ sender_type: 'customer', content_type: 'text', created_at: hace(24 * 60) }, ahora)).toBe(false))
  it('lo último es nuestro: no', () =>
    expect(quedaPendiente({ sender_type: 'bot', content_type: 'text', created_at: hace(30) }, ahora)).toBe(false))
  it('imagen (comprobante): la atiende el lector, no el barrido', () =>
    expect(quedaPendiente({ sender_type: 'customer', content_type: 'image', created_at: hace(30) }, ahora)).toBe(false))
  it('sin mensajes: no', () => expect(quedaPendiente(null, ahora)).toBe(false))
})
