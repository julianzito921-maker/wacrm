import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  cargarCatalogo,
  catalogoParaPrompt,
  importesFueraDeCatalogo,
  normalizarProducto,
  preciosConocidos,
  type ProductoCatalogo,
} from './catalogo'

const PACK: ProductoCatalogo = {
  clave: 'pack',
  nombre: 'Pack 150 Amigurumis de Navidad',
  precio: null,
  moneda: 'MXN',
  aporteVoluntario: true,
  valoresSugeridos: [100, 150, 200, 300],
  incluye: ['150 patrones', '4 bonos'],
  notas: 'Material digital en PDF',
  orden: 1,
}

const BONO: ProductoCatalogo = {
  clave: 'bono-plan',
  nombre: 'Bono 4 · Plan de 14 días',
  precio: 99,
  moneda: 'MXN',
  aporteVoluntario: false,
  valoresSugeridos: [],
  incluye: [],
  notas: null,
  orden: 5,
}

describe('normalizarProducto', () => {
  it('convierte numéricos que PostgREST devuelve como texto', () => {
    const p = normalizarProducto({
      clave: ' x ',
      nombre: ' Producto ',
      precio: '199.00',
      moneda: null,
      aporte_voluntario: false,
      valores_sugeridos: ['100', 150],
      incluye: ['a'],
      notas: null,
      orden: null,
    })
    expect(p.precio).toBe(199)
    expect(p.moneda).toBe('MXN')
    expect(p.valoresSugeridos).toEqual([100, 150])
    expect(p.orden).toBe(100)
  })

  it('marca aporte voluntario cuando el precio es null, aunque la columna diga lo contrario', () => {
    const p = normalizarProducto({
      clave: 'pack',
      nombre: 'Pack',
      precio: null,
      moneda: 'MXN',
      aporte_voluntario: false,
      valores_sugeridos: [100],
      incluye: null,
      notas: null,
      orden: 1,
    })
    expect(p.aporteVoluntario).toBe(true)
  })
})

describe('catalogoParaPrompt', () => {
  it('devuelve cadena vacía sin productos', () => {
    expect(catalogoParaPrompt([])).toBe('')
  })

  it('escribe los valores sugeridos del aporte voluntario y los precios fijos', () => {
    const texto = catalogoParaPrompt([PACK, BONO])
    expect(texto).toContain('aporte voluntario')
    expect(texto).toContain('$100 · $150 · $200 · $300 MXN')
    expect(texto).toContain('$99 MXN')
    expect(texto).toContain('150 patrones; 4 bonos')
  })

  it('en modo estricto prohíbe inventar precios y exige la etiqueta pide-humano', () => {
    const texto = catalogoParaPrompt([PACK], { estricto: true })
    expect(texto).toContain('REGLA DE PRECIOS')
    expect(texto).toContain('[[ETIQUETA:pide-humano]]')
  })

  it('en modo flexible no incluye la regla dura', () => {
    const texto = catalogoParaPrompt([PACK], { estricto: false })
    expect(texto).not.toContain('REGLA DE PRECIOS')
  })
})

describe('preciosConocidos e importesFueraDeCatalogo', () => {
  it('reúne precio fijo y valores sugeridos', () => {
    expect(preciosConocidos([PACK, BONO])).toEqual([99, 100, 150, 200, 300])
  })

  it('detecta un precio inventado en la respuesta', () => {
    const fuera = importesFueraDeCatalogo('Te lo dejo en $450 y con envío gratis', [PACK])
    expect(fuera).toEqual([450])
  })

  it('no marca los precios del catálogo ni los valores sugeridos', () => {
    const fuera = importesFueraDeCatalogo('Son $100 o $200, tú decides', [PACK])
    expect(fuera).toEqual([])
  })

  it('ignora textos sin importes', () => {
    expect(importesFueraDeCatalogo('Te lo mando ahora mismo 🧶', [PACK])).toEqual([])
  })
})

function fakeDb(respuesta: { data?: unknown; error?: unknown }) {
  const order = vi.fn().mockResolvedValue(respuesta)
  const eqActivo = vi.fn(() => ({ order }))
  const eqCuenta = vi.fn(() => ({ eq: eqActivo }))
  const select = vi.fn(() => ({ eq: eqCuenta }))
  const db = { from: vi.fn(() => ({ select })) }
  return { db: db as unknown as SupabaseClient, from: db.from }
}

describe('cargarCatalogo', () => {
  it('normaliza las filas y descarta las incompletas', async () => {
    const { db, from } = fakeDb({
      data: [
        { clave: 'pack', nombre: 'Pack', precio: null, moneda: 'MXN', aporte_voluntario: true, valores_sugeridos: [100], incluye: [], notas: null, orden: 1 },
        { clave: '', nombre: 'sin clave', precio: 1, moneda: 'MXN', aporte_voluntario: false, valores_sugeridos: [], incluye: [], notas: null, orden: 2 },
      ],
      error: null,
    })
    const productos = await cargarCatalogo(db, 'acct-1')
    expect(from).toHaveBeenCalledWith('product_catalog')
    expect(productos).toHaveLength(1)
    expect(productos[0].clave).toBe('pack')
  })

  it('nunca lanza: devuelve lista vacía si la consulta falla', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'boom' } })
    await expect(cargarCatalogo(db, 'acct-1')).resolves.toEqual([])
  })
})
