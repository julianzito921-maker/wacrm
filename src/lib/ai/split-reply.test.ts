import { describe, expect, it } from 'vitest'
import { splitReplyParts } from './auto-reply'

describe('splitReplyParts', () => {
  it('parte en [[CORTE]]', () => {
    expect(splitReplyParts('hola [[CORTE]] 722969020234802101')).toEqual(['hola', '722969020234802101'])
  })
  it('cada párrafo (renglón en blanco) sale como mensaje aparte', () => {
    expect(splitReplyParts('Qué padre 💚\n\n¿Y qué te ha frenado?')).toEqual(['Qué padre 💚', '¿Y qué te ha frenado?'])
  })
  it('los saltos de línea simples se quedan en el mismo mensaje', () => {
    expect(splitReplyParts('Total: *$99*\nPaga aquí 👇')).toEqual(['Total: *$99*\nPaga aquí 👇'])
  })
  it('la tarjeta pegada al último texto se separa', () => {
    expect(splitReplyParts('4217 4701 2154 2340\n\nCuando pagues, mándame la foto')).toEqual(['4217 4701 2154 2340', 'Cuando pagues, mándame la foto'])
  })
  it('deja 2 mensajes como mucho (regla anti-baneo: máximo 2 seguidos)', () => {
    const r = splitReplyParts(Array.from({ length: 10 }, (_, i) => `m${i}`).join(' [[CORTE]] '))
    expect(r).toHaveLength(2)
    expect(r[1]).toBe('m1\nm2\nm3\nm4\nm5\nm6\nm7\nm8\nm9')
  })
  it('con un archivo en la respuesta, el texto cabe en 1 mensaje (texto + archivo = 2)', () => {
    const r = splitReplyParts('Aquí va tu guía 💚\n\n¿La pudiste abrir? [[ARCHIVO:metodo]]', 1)
    expect(r).toEqual(['Aquí va tu guía 💚\n¿La pudiste abrir? [[ARCHIVO:metodo]]'])
  })

  it('el tope se puede subir por entorno sin desplegar', () => {
    process.env.AI_MAX_PARTES = '5'
    try {
      const r = splitReplyParts(Array.from({ length: 10 }, (_, i) => `m${i}`).join(' [[CORTE]] '))
      expect(r).toHaveLength(5)
    } finally {
      delete process.env.AI_MAX_PARTES
    }
  })
  it('texto vacío no rompe', () => {
    expect(splitReplyParts('   ')).toEqual([''])
  })
})
