import { describe, expect, it } from 'vitest'
import { ETIQUETAS_PROHIBIDAS, separarAcciones } from './acciones'

describe('separarAcciones', () => {
  it('saca etiquetas y botones y deja el texto limpio', () => {
    expect(separarAcciones('¡Va! Te lo mando ahorita 💚\n[[BOTON:n2_si]]')).toEqual({
      texto: '¡Va! Te lo mando ahorita 💚',
      etiquetas: [],
      botones: ['n2_si'],
    })
  })
  it('varias marcas mezcladas con [[CORTE]] y [[ARCHIVO]] (esas no las toca)', () => {
    const r = separarAcciones('Total *$99*\n[[ARCHIVO:metodo]] [[ETIQUETA:Pago-por-verificar]] [[CORTE]] clave [[ETIQUETA:pago-por-verificar]]')
    expect(r.etiquetas).toEqual(['pago-por-verificar'])
    expect(r.texto).toContain('[[ARCHIVO:metodo]]')
    expect(r.texto).toContain('[[CORTE]]')
    expect(r.texto).not.toContain('ETIQUETA')
  })
  it('sin marcas no cambia nada', () => {
    expect(separarAcciones('Hola, qué gusto 💚')).toEqual({ texto: 'Hola, qué gusto 💚', etiquetas: [], botones: [] })
  })
  it('pagado y extra-pagado están prohibidas para la IA', () => {
    expect(ETIQUETAS_PROHIBIDAS.has('pagado')).toBe(true)
    expect(ETIQUETAS_PROHIBIDAS.has('extra-pagado')).toBe(true)
    expect(ETIQUETAS_PROHIBIDAS.has('pago-por-verificar')).toBe(false)
  })
})
