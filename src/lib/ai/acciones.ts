// Acciones que la agente de IA pide con marcas internas (nunca llegan a la clienta):
//   [[ETIQUETA:pago-por-verificar]] → pone esa etiqueta (y dispara sus automatizaciones), como hacía el embudo.
//   [[BOTON:n2_si]]                 → equivale a que la clienta tocara ese botón (dispara las
//                                      automatizaciones interactive_reply con ese id: upsell, downsell…).
// Sirve para vender 100 % conversando, sin botones ni menús (13-nov-2026).

/** La IA nunca puede marcar un pago como hecho: eso lo hace el lector de comprobantes o una persona. */
export const ETIQUETAS_PROHIBIDAS = new Set(['pagado', 'extra-pagado'])

const ETIQUETA = /\[\[\s*ETIQUETA\s*:\s*([\w-]+)\s*\]\]/gi
const BOTON = /\[\[\s*BOTON\s*:\s*([\w-]+)\s*\]\]/gi

/** Quita las marcas de acción del texto y devuelve las etiquetas y botones pedidos (sin repetir, en orden). */
export function separarAcciones(texto: string): { texto: string; etiquetas: string[]; botones: string[] } {
  const etiquetas: string[] = []
  const botones: string[] = []
  const limpio = texto
    .replace(ETIQUETA, (_, n: string) => {
      const v = n.toLowerCase()
      if (!etiquetas.includes(v)) etiquetas.push(v)
      return ''
    })
    .replace(BOTON, (_, n: string) => {
      const v = n.toLowerCase()
      if (!botones.includes(v)) botones.push(v)
      return ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { texto: limpio, etiquetas, botones }
}
