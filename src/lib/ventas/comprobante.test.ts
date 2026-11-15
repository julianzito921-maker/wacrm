import { describe, expect, it } from 'vitest'
import { evaluarComprobante, type LecturaComprobante } from './comprobante'

const base: LecturaComprobante = {
  es_comprobante: true, monto: 99, banco_destino: 'MERCADO PAGO', ultimos_digitos_destino: '2101',
  estado: 'exitosa', fecha: '11 nov 2026', referencia: '1111026', tipo: 'spei',
}
const DIG = ['2101', '2340']
const MONTOS = [59, 69, 99, 168, 199, 237]

describe('evaluarComprobante', () => {
  it('acepta un comprobante exitoso con destino y monto correctos', () => {
    expect(evaluarComprobante(base, DIG, MONTOS)).toEqual({ ok: true, motivos: [] })
  })
  it('acepta la tarjeta de OXXO aunque venga con espacios o asteriscos', () => {
    expect(evaluarComprobante({ ...base, ultimos_digitos_destino: '**** 2340', monto: 168 }, DIG, MONTOS).ok).toBe(true)
  })
  it('marca para revisar si el destino no coincide', () => {
    const r = evaluarComprobante({ ...base, ultimos_digitos_destino: '9999' }, DIG, MONTOS)
    expect(r.ok).toBe(false)
    expect(r.motivos[0]).toContain('9999')
  })
  it('marca para revisar un monto que no corresponde a ningún producto', () => {
    expect(evaluarComprobante({ ...base, monto: 50 }, DIG, MONTOS).ok).toBe(false)
  })
  it('marca para revisar una transferencia pendiente', () => {
    expect(evaluarComprobante({ ...base, estado: 'pendiente' }, DIG, MONTOS).motivos).toContain('estado: pendiente')
  })
  it('rechaza lo que no es comprobante', () => {
    expect(evaluarComprobante({ ...base, es_comprobante: false }, DIG, MONTOS)).toEqual({ ok: false, motivos: ['no parece comprobante'] })
  })
  it('sin listas configuradas solo exige que sea un comprobante exitoso', () => {
    expect(evaluarComprobante({ ...base, ultimos_digitos_destino: null, monto: null }, [], []).ok).toBe(true)
  })
})
