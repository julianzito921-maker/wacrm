// La agente de IA no pega enlaces: escribe [[ARCHIVO:clave]] y el servidor manda
// ese archivo como adjunto de WhatsApp (los enlaces dan desconfianza en México).
// El mapa clave → archivo vive en ai_configs.archivos (migración 061).

export type TipoArchivo = 'document' | 'audio' | 'image' | 'video'

export interface ArchivoIa {
  url: string
  nombre?: string
  tipo?: TipoArchivo
  pie?: string
}

const MARCA = /\[\[\s*ARCHIVO\s*:\s*([\w-]+)\s*\]\]/gi

/** Separa una parte de la respuesta en su texto (sin marcas) y las claves de archivo, en orden. */
export function separarArchivos(parte: string): { texto: string; claves: string[] } {
  const claves: string[] = []
  const texto = parte
    .replace(MARCA, (_, clave: string) => {
      claves.push(clave.toLowerCase())
      return ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { texto, claves }
}

/** Normaliza el JSON guardado en la base: solo entradas con una URL https válida. */
export function mapaDeArchivos(valor: unknown): Record<string, ArchivoIa> {
  const mapa: Record<string, ArchivoIa> = {}
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return mapa
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const a = v as Record<string, unknown>
    if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) continue
    const tipo = ['document', 'audio', 'image', 'video'].includes(a.tipo as string) ? (a.tipo as TipoArchivo) : 'document'
    mapa[clave.toLowerCase()] = {
      url: a.url,
      tipo,
      nombre: typeof a.nombre === 'string' ? a.nombre : undefined,
      pie: typeof a.pie === 'string' ? a.pie : undefined,
    }
  }
  return mapa
}
