import { describe, expect, it } from 'vitest'
import { valorDeCompra } from './conversiones'

describe('valorDeCompra', () => {
  it('usa el monto que leyó el lector de comprobantes', () => {
    expect(valorDeCompra('pagado', ['quiere-antojos'], { monto_pagado: '168' })).toBe(168)
  })
  it('Método solo: $99', () => {
    expect(valorDeCompra('pagado', ['caso-hambre'], {})).toBe(99)
  })
  it('Método + Antojos + Menopausia: $237', () => {
    expect(valorDeCompra('pagado', ['quiere-antojos', 'quiere-menopausia'], {})).toBe(237)
  })
  it('Glúteos: Método + recetario + ligas: $197', () => {
    expect(valorDeCompra('pagado', ['meta-levantado', 'quiere-recetario', 'quiere-ligas'], {})).toBe(197)
  })
  it('Glúteos: Método + un order bump: $148', () => {
    expect(valorDeCompra('pagado', ['quiere-ligas'], {})).toBe(148)
  })
  it('downsell de la guía sola: $59', () => {
    expect(valorDeCompra('pagado', ['compro-59'], {})).toBe(59)
  })
  it('extra: usa el monto pendiente del complemento', () => {
    expect(valorDeCompra('extra-pagado', ['cliente-chia'], { monto_pendiente: '199' })).toBe(199)
  })
  it('un monto leído vacío (ya usado) no cuenta', () => {
    expect(valorDeCompra('pagado', [], { monto_pagado: '' })).toBe(99)
  })
})
