import { describe, it, expect, vi } from 'vitest'
vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }))
import { esAcuseCorto, yaRespondido, hayEntranteMasNuevo } from './auto-reply'

// Caso real (Roberta Victoria, 13-nov): «Claro» y «Gracias» seguidos → dos cierres intercalados.
const recientes = [
  { message_id: 'b3', sender_type: 'bot' },
  { message_id: 'b2', sender_type: 'bot' },
  { message_id: 'gracias', sender_type: 'customer', content_type: 'text', content_text: 'Gracias' },
  { message_id: 'claro', sender_type: 'customer', content_type: 'text', content_text: 'Claro' },
]

describe('fila de respuestas por conversación', () => {
  it('acuses cortos sin pregunta', () => {
    expect(esAcuseCorto('text', 'Gracias')).toBe(true)
    expect(esAcuseCorto('text', 'Ok muchas gracias 💚')).toBe(true)
    expect(esAcuseCorto('text', '¿Y cuánto cuesta?')).toBe(false)
    expect(esAcuseCorto('text', 'yo peso 78 y tengo 47 años')).toBe(false)
    expect(esAcuseCorto('audio', 'ok')).toBe(false)
  })
  it('detecta que ya se respondió después del mensaje', () => {
    expect(yaRespondido(recientes, 'gracias')).toBe(true)
    expect(yaRespondido(recientes.slice(2), 'gracias')).toBe(false)
  })
  it('detecta un mensaje de la clienta más nuevo', () => {
    expect(hayEntranteMasNuevo(recientes, 'claro')).toBe(true)
    expect(hayEntranteMasNuevo(recientes, 'gracias')).toBe(false)
  })
})
