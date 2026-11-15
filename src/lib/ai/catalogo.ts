// ============================================================
// Catálogo de productos de la cuenta (Etapa 1 del orquestador).
//
// Por qué existe: la base de conocimiento es texto libre y su
// recuperación puede traer un precio incompleto. Cuando el agente
// responde un precio, equivocarse es caro —se pierde la venta o se
// regala el producto— así que los precios viven en filas estructuradas
// (`product_catalog`) y se inyectan literales en el prompt.
//
// Nunca lanza: si el catálogo no se puede leer, el agente sigue
// respondiendo como antes (sin precios), que es mejor que no responder.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProductoCatalogo {
  clave: string
  nombre: string
  /** null cuando el producto va por aporte voluntario. */
  precio: number | null
  moneda: string
  aporteVoluntario: boolean
  valoresSugeridos: number[]
  incluye: string[]
  notas: string | null
  orden: number
}

interface FilaCatalogo {
  clave: string
  nombre: string
  precio: number | string | null
  moneda: string | null
  aporte_voluntario: boolean | null
  valores_sugeridos: (number | string)[] | null
  incluye: string[] | null
  notas: string | null
  orden: number | null
}

const COLUMNAS = 'clave, nombre, precio, moneda, aporte_voluntario, valores_sugeridos, incluye, notas, orden'

function aNumero(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === '') return null
  const n = Number(valor)
  return Number.isFinite(n) ? n : null
}

/** Normaliza una fila de la base a la forma que usa el prompt. */
export function normalizarProducto(fila: FilaCatalogo): ProductoCatalogo {
  return {
    clave: String(fila.clave ?? '').trim(),
    nombre: String(fila.nombre ?? '').trim(),
    precio: aNumero(fila.precio),
    moneda: (fila.moneda ?? 'MXN').trim() || 'MXN',
    aporteVoluntario: fila.aporte_voluntario === true || aNumero(fila.precio) === null,
    valoresSugeridos: (fila.valores_sugeridos ?? [])
      .map((v) => aNumero(v))
      .filter((v): v is number => v !== null),
    incluye: (fila.incluye ?? []).map((i) => String(i)).filter(Boolean),
    notas: fila.notas ? String(fila.notas).trim() : null,
    orden: fila.orden ?? 100,
  }
}

/** Lee el catálogo activo de una cuenta, ordenado. Nunca lanza. */
export async function cargarCatalogo(
  db: SupabaseClient,
  accountId: string,
): Promise<ProductoCatalogo[]> {
  try {
    const { data, error } = await db
      .from('product_catalog')
      .select(COLUMNAS)
      .eq('account_id', accountId)
      .eq('activo', true)
      .order('orden', { ascending: true })
    if (error) {
      console.error('[catalogo] no se pudo leer:', error.message ?? error)
      return []
    }
    return ((data ?? []) as unknown as FilaCatalogo[])
      .map(normalizarProducto)
      .filter((p) => p.clave && p.nombre)
  } catch (err) {
    console.error('[catalogo] lectura falló:', err instanceof Error ? err.message : err)
    return []
  }
}

function pesos(valor: number): string {
  const entero = Math.round(valor * 100) / 100
  return Number.isInteger(entero) ? `$${entero}` : `$${entero.toFixed(2)}`
}

/** Bloque de prompt con los precios exactos. Cadena vacía si no hay catálogo. */
export function catalogoParaPrompt(
  productos: ProductoCatalogo[],
  opts: { estricto?: boolean } = {},
): string {
  if (productos.length === 0) return ''
  const { estricto = true } = opts
  const moneda = productos[0]?.moneda ?? 'MXN'

  const lineas = productos.map((p) => {
    const precio = p.aporteVoluntario
      ? p.valoresSugeridos.length > 0
        ? `aporte voluntario (sin precio fijo). Valores de referencia: ${p.valoresSugeridos.map(pesos).join(' · ')} ${p.moneda}`
        : 'aporte voluntario (sin precio fijo)'
      : `${pesos(p.precio ?? 0)} ${p.moneda}`
    const partes = [`- ${p.nombre} (clave: ${p.clave}) — ${precio}`]
    if (p.incluye.length > 0) partes.push(`  Incluye: ${p.incluye.join('; ')}.`)
    if (p.notas) partes.push(`  Notas: ${p.notas}`)
    return partes.join('\n')
  })

  const reglas = estricto
    ? [
        'REGLA DE PRECIOS: responde únicamente con los precios que aparecen en este catálogo.',
        'Si te preguntan por un producto o un importe que no está aquí, no lo inventes: responde que lo confirmas con una persona y escribe [[ETIQUETA:pide-humano]].',
        'Nunca ofrezcas descuentos que no estén escritos aquí.',
      ]
    : ['Usa este catálogo como referencia; si falta un dato, confírmalo con una persona.']

  return [`## Catálogo de la cuenta (moneda: ${moneda})`, ...lineas, '', ...reglas].join('\n')
}

/** Importes que sí conocemos, para auditar respuestas. */
export function preciosConocidos(productos: ProductoCatalogo[]): number[] {
  const precios = new Set<number>()
  for (const p of productos) {
    if (p.precio !== null) precios.add(p.precio)
    for (const v of p.valoresSugeridos) precios.add(v)
  }
  return [...precios].sort((a, b) => a - b)
}

/**
 * Importes que la respuesta menciona y NO están en el catálogo.
 * No bloquea nada: sirve para registrar y detectar alucinaciones.
 */
export function importesFueraDeCatalogo(texto: string, productos: ProductoCatalogo[]): number[] {
  const conocidos = new Set(preciosConocidos(productos))
  const encontrados = texto.match(/\$\s?\d{1,6}(?:[.,]\d{2})?/g) ?? []
  const fuera = new Set<number>()
  for (const bruto of encontrados) {
    const n = Number(bruto.replace(/[^\d.]/g, '').replace(',', '.'))
    if (!Number.isFinite(n)) continue
    if (!conocidos.has(Math.round(n * 100) / 100)) fuera.add(Math.round(n * 100) / 100)
  }
  return [...fuera].sort((a, b) => a - b)
}
