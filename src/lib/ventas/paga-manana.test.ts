import { describe, expect, it } from 'vitest'
import { diceQuePagaManana } from './paga-manana'

describe('diceQuePagaManana', () => {
  it.each([
    'Mañana pago', 'mañana te pago', 'manana deposito', 'Mañana me reporto', 'Te deposito mañana temprano',
    'mañana te mando el comprobante', 'Ok mañana hago la transferencia', 'Mañana le pago sin falta', 'mañana te aviso',
  ])('sí: %s', (t) => expect(diceQuePagaManana(t)).toBe(true))
  it.each([
    'Hola quiero mi dosis', 'Ya pagué', '¿Cuánto es?', 'Mañana empiezo con la chía', 'Mañana no puedo pagar', 'ya te mandé el comprobante',
  ])('no: %s', (t) => expect(diceQuePagaManana(t)).toBe(false))
})
