import { describe, it, expect } from 'vitest'
import { textoConExtra } from './mensaje-extra'

describe('textoConExtra', () => {
  it('el mensaje del anuncio solo NO necesita a la IA', () => {
    expect(textoConExtra('¡Hola! Quiero mi dosis de chía 🌱', true)).toBe(false)
    expect(textoConExtra('Hola buenas tardes, quiero información del método chía', true)).toBe(false)
  })
  it('caso Graciela: datos y salud en el primer mensaje', () => {
    expect(
      textoConExtra('¡Hola! Quiero mi dosis de chía 🌱saludos  tengo  58 años peso 95 kg prlomemas de hipertencion  y glucosa altas', true),
    ).toBe(true)
  })
  it('preguntas o datos al inicio', () => {
    expect(textoConExtra('Hola quiero mi dosis de chía, ¿cuánto cuesta?', true)).toBe(true)
    expect(textoConExtra('Quiero mi dosis de chía peso 80 kilos y tengo 45', true)).toBe(true)
  })
  it('a media pregunta solo salud o dudas', () => {
    expect(textoConExtra('87 kilos mido 1,67', false)).toBe(false)
    expect(textoConExtra('tengo 52 años', false)).toBe(false)
    expect(textoConExtra('47 y soy diabética', false)).toBe(true)
    expect(textoConExtra('las dos, ¿la puedo tomar si tomo pastillas?', false)).toBe(true)
  })
})
