import { describe, expect, it } from 'vitest'
import { mapaDeArchivos, separarArchivos } from './archivos'

describe('separarArchivos', () => {
  it('saca la marca y deja el texto limpio', () => {
    expect(separarArchivos('¡Perfecto! 💚 Aquí está tu Método 👇\n[[ARCHIVO:metodo]]\n\nTotal: *$99*')).toEqual({
      texto: '¡Perfecto! 💚 Aquí está tu Método 👇\n\nTotal: *$99*',
      claves: ['metodo'],
    })
  })
  it('varias marcas, en orden, sin importar mayúsculas ni espacios', () => {
    expect(separarArchivos('[[archivo: Metodo]] [[ ARCHIVO:ligas ]]')).toEqual({ texto: '', claves: ['metodo', 'ligas'] })
  })
  it('sin marcas no cambia nada', () => {
    expect(separarArchivos('Hola 💚')).toEqual({ texto: 'Hola 💚', claves: [] })
  })
  it('no confunde [[CORTE]] ni otras marcas', () => {
    expect(separarArchivos('a [[CORTE]] b').claves).toEqual([])
  })
})

describe('mapaDeArchivos', () => {
  it('acepta solo URLs https y pone document por defecto', () => {
    expect(
      mapaDeArchivos({
        Metodo: { url: 'https://x.co/M.pdf', nombre: 'M.pdf' },
        malo: { url: 'http://x.co/a.pdf' },
        audio: { url: 'https://x.co/a.ogg', tipo: 'audio' },
        raro: 'texto',
      }),
    ).toEqual({
      metodo: { url: 'https://x.co/M.pdf', nombre: 'M.pdf', tipo: 'document', pie: undefined },
      audio: { url: 'https://x.co/a.ogg', tipo: 'audio', nombre: undefined, pie: undefined },
    })
  })
  it('valores vacíos o inválidos dan un mapa vacío', () => {
    expect(mapaDeArchivos(null)).toEqual({})
    expect(mapaDeArchivos([])).toEqual({})
  })
})
