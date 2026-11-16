import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guardia de arquitectura de la Fase 1.
 *
 * Regla: sólo `lib/messaging/send.ts` puede llamar a las funciones de
 * envío de `meta-api`. Todo lo demás (flujos, automatizaciones, IA,
 * envío manual, difusión, ventas) pasa por el punto único, que es el que
 * deja el registro de auditoría.
 *
 * Sin esta prueba la regla se rompe sola en el siguiente cambio: basta
 * con que alguien importe `sendTextMessage` en un módulo nuevo para
 * volver a tener envíos invisibles.
 *
 * `sendTypingIndicator` no cuenta: no es un mensaje, es el «escribiendo…».
 */

const RAIZ = join(process.cwd(), 'src')
const PERMITIDOS = new Set(['lib/messaging/send.ts'])
const PROHIBIDOS = [
  'sendTextMessage',
  'sendMediaMessage',
  'sendTemplateMessage',
  'sendInteractiveButtons',
  'sendInteractiveList',
]

function archivos(dir: string): string[] {
  const salida: string[] = []
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada)
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta))
    else if (/\.(ts|tsx)$/.test(entrada) && !/\.test\.(ts|tsx)$/.test(entrada)) salida.push(ruta)
  }
  return salida
}

describe('salida única de WhatsApp (arquitectura)', () => {
  it('nadie llama a las funciones de envío de meta-api fuera del punto único', () => {
    const infractores: string[] = []

    for (const ruta of archivos(RAIZ)) {
      const rel = relative(RAIZ, ruta).replace(/\\/g, '/')
      if (PERMITIDOS.has(rel)) continue
      const contenido = readFileSync(ruta, 'utf8')
      // Se mira sólo el bloque de import desde meta-api: los mocks de las
      // pruebas y los comentarios no importan aquí.
      const bloques = contenido.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'@\/lib\/whatsapp\/meta-api'/g)
      for (const bloque of bloques) {
        const importados = bloque[1].split(',').map((s) => s.trim())
        const infractor = importados.find((n) => PROHIBIDOS.includes(n))
        if (infractor) infractores.push(`${rel} importa ${infractor}`)
      }
    }

    expect(infractores).toEqual([])
  })

  it('el punto único existe y exporta los envoltorios por tipo', () => {
    const contenido = readFileSync(join(RAIZ, 'lib/messaging/send.ts'), 'utf8')
    for (const nombre of [
      'enviarSaliente',
      'enviarTexto',
      'enviarMedio',
      'enviarPlantilla',
      'enviarBotones',
      'enviarLista',
    ]) {
      expect(contenido).toContain(`export async function ${nombre}`)
    }
  })
})
