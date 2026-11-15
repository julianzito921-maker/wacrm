// Mensajes que el embudo consume pero que traen algo MÁS (13-nov-2026, caso Graciela):
// «¡Hola! Quiero mi dosis de chía 🌱 tengo 58 años, peso 95 kg, hipertensión y glucosa alta».
// El embudo arrancaba con la frase del anuncio y nadie contestaba lo demás. Con esto,
// además del embudo, contesta la IA (que tiene la sección de salud).

const RELLENO = new Set([
  'hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tardes', 'noches', 'saludos', 'que', 'tal',
  'quiero', 'quisiera', 'me', 'interesa', 'mi', 'tu', 'la', 'el', 'de', 'del', 'por', 'favor', 'porfa', 'gracias',
  'dosis', 'proporcion', 'chia', 'metodo', 'saciante', 'info', 'informacion', 'mas', 'si', 'ok', 'y', 'a', 'un', 'una',
])

const SALUD =
  /diabet|glucosa|azucar alta|insulina|metformina|presion|hipertens|tiroid|levotiroxina|embaraz|lactan|amamant|gastritis|colitis|colon|crohn|estren|medicament|pastilla|operad|cirugia|bariatr|manga gastrica|rinon|renal|higado|anticoag|warfarina|alergi|cancer|quimio|corazon|cardi|epilep/

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s?¿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * ¿El texto trae algo que la IA debe contestar aunque el embudo lo haya tomado?
 * - inicio (el mensaje arrancó el embudo): si menciona salud, pregunta algo o trae 3+ palabras
 *   más allá del saludo del anuncio.
 * - a media pregunta (respuesta escrita que el embudo aceptó): solo si menciona salud o pregunta algo.
 */
export function textoConExtra(texto: string, inicio: boolean): boolean {
  const t = normalizar(texto)
  if (!t) return false
  if (SALUD.test(t)) return true
  if (/[?¿]/.test(texto)) return true
  if (!inicio) return false
  const resto = t.split(' ').filter((w) => w && !RELLENO.has(w) && !/^[?¿]+$/.test(w))
  return resto.length >= 3
}
