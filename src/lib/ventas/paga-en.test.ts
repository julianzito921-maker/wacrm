import { describe, it, expect } from 'vitest'
import { cuandoPaga } from './paga-en'

// 12-nov-2026 18:18 en Ciudad de México (UTC-6) = 00:18 UTC del 13.
const AHORA = new Date('2026-11-13T00:18:00Z')
const horas = (d: Date | null) => (d ? Math.round((d.getTime() - AHORA.getTime()) / 60_000) : null)

describe('cuandoPaga', () => {
  it('el caso real: «Que sea 3horas que vivo lejos del oxxo» con pedido pendiente', () => {
    expect(horas(cuandoPaga('Que sea 3horas que vivo lejosdel un oxxo', AHORA, true))).toBe(180)
  })
  it('relativos con palabra de pago, sin pedido', () => {
    expect(horas(cuandoPaga('en 2 horas te pago', AHORA, false))).toBe(120)
    expect(horas(cuandoPaga('te deposito en media hora', AHORA, false))).toBe(30)
    expect(horas(cuandoPaga('en una hora transfiero', AHORA, false))).toBe(60)
    expect(horas(cuandoPaga('pago en hora y media', AHORA, false))).toBe(90)
    expect(horas(cuandoPaga('en 40 minutos te mando el comprobante', AHORA, false))).toBe(40)
    expect(horas(cuandoPaga('pago en 2 horas y media', AHORA, false))).toBe(150)
  })
  it('hora de reloj (hoy, en México)', () => {
    expect(horas(cuandoPaga('a las 8 pago', AHORA, false))).toBe(102) // 20:00
    expect(horas(cuandoPaga('te deposito a las 7:30 de la noche', AHORA, false))).toBe(72)
    expect(horas(cuandoPaga('a las 21 hrs transfiero', AHORA, false))).toBe(162)
  })
  it('no agenda sin contexto de pago ni pedido', () => {
    expect(cuandoPaga('en 2 horas salgo del trabajo', AHORA, false)).toBeNull()
  })
  it('no confunde frases que no son de cuándo paga', () => {
    expect(cuandoPaga('tengo 3 horas sin comer', AHORA, true)).toBeNull()
    expect(cuandoPaga('llevo 2 horas esperando para pagar', AHORA, false)).toBeNull()
  })
  it('«mañana» lo maneja paga-manana', () => {
    expect(cuandoPaga('mañana a las 10 pago', AHORA, true)).toBeNull()
  })
  it('fuera de rango: menos de 10 min o más de 23 h', () => {
    expect(cuandoPaga('pago en 5 minutos', AHORA, false)).toBeNull()
    expect(cuandoPaga('pago en 30 horas', AHORA, false)).toBeNull()
  })
})
