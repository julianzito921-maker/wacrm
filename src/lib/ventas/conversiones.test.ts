import { describe, expect, it } from 'vitest'
import { armarEventoMeta, valorDeCompra } from './conversiones'

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

describe('armarEventoMeta (nodo Meta CAPI del Flow Builder)', () => {
  const base = { eventId: 'run-1-capi', wabaId: 'waba-1', ctwaClid: 'clid-1', ahora: new Date('2026-11-22T12:00:00Z') }

  it('Compra con valor y moneda, ligada al clic del anuncio', () => {
    expect(armarEventoMeta({ ...base, eventName: 'Purchase', value: 99, currency: 'MXN' })).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(base.ahora.getTime() / 1000),
      event_id: 'run-1-capi',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: 'waba-1', ctwa_clid: 'clid-1' },
      custom_data: { currency: 'MXN', value: 99 },
    })
  })

  it('Lead sin valor no manda value; la moneda por defecto es MXN', () => {
    expect(armarEventoMeta({ ...base, eventName: 'Lead' }).custom_data).toEqual({ currency: 'MXN' })
  })
})
