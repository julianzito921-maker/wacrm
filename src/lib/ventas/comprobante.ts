// ============================================================
// Lectura automática de comprobantes de pago (SCALE WHATSAPP).
//
// Cuando una clienta con pago pendiente (etiqueta «pago-por-verificar» o
// «extra-por-verificar») manda una imagen, la IA de la cuenta (modelo con
// visión, p. ej. DeepSeek Flash) lee el comprobante: monto, banco, últimos
// dígitos de la cuenta destino, estado, fecha y referencia. Luego:
//   - le contesta a la clienta al momento (recibido / no parece comprobante),
//   - etiqueta «comprobante-recibido» + «comprobante-ok» o «comprobante-revisar»,
//   - deja una nota en el contacto con lo leído para que una persona confirme.
// Opcional: COMPROBANTE_AUTO_PAGADO=on pone «pagado» cuando todo coincide.
//
// Configuración por variables de entorno:
//   COMPROBANTE_DIGITOS  últimos 4 dígitos válidos de destino, separados por coma
//   COMPROBANTE_MONTOS   montos válidos en pesos, separados por coma
// Nunca lanza: un fallo aquí no debe afectar la respuesta del webhook a Meta.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { loadAiConfig } from '@/lib/ai/config'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { guardarValor } from '@/lib/ventas/conversiones'

const ETIQUETAS_PENDIENTE = ['pago-por-verificar', 'extra-por-verificar']
const MAX_BYTES = 5 * 1024 * 1024

export interface LecturaComprobante {
  es_comprobante: boolean
  monto: number | null
  banco_destino: string | null
  ultimos_digitos_destino: string | null
  estado: string | null
  fecha: string | null
  referencia: string | null
  tipo: string | null
}

const PROMPT =
  'Analiza la imagen. Responde SOLO JSON: {"es_comprobante": bool, "monto": number|null, "moneda": string|null, ' +
  '"banco_destino": string|null, "ultimos_digitos_destino": string|null, "estado": "exitosa"|"pendiente"|"fallida"|"desconocido", ' +
  '"fecha": string|null, "referencia": string|null, "tipo": "spei"|"oxxo"|"otro"|null}. ' +
  '"es_comprobante" es true solo si es un comprobante o ticket de un pago, transferencia o depósito. ' +
  '"ultimos_digitos_destino" = los últimos 4 dígitos de la cuenta, CLABE o tarjeta a la que se envió el dinero.'

const lista = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/** ¿Coincide con lo que esperamos? Exportado para pruebas. */
export function evaluarComprobante(
  l: LecturaComprobante,
  digitos: string[],
  montos: number[],
): { ok: boolean; motivos: string[] } {
  const motivos: string[] = []
  if (!l.es_comprobante) return { ok: false, motivos: ['no parece comprobante'] }
  if (l.estado && l.estado !== 'exitosa') motivos.push(`estado: ${l.estado}`)
  const dig = (l.ultimos_digitos_destino ?? '').replace(/\D/g, '').slice(-4)
  if (digitos.length && !digitos.includes(dig)) motivos.push(`destino …${dig || '?'} no coincide`)
  if (montos.length && (l.monto == null || !montos.some((m) => Math.abs(m - Number(l.monto)) < 0.5))) {
    motivos.push(`monto ${l.monto ?? '?'} no esperado`)
  }
  return { ok: motivos.length === 0, motivos }
}

// PDF: no hay imagen que mirar, así que se le pasa a la IA el texto que
// trae el archivo (los bancos en México lo descargan así).
const PROMPT_PDF =
  'Este es el TEXTO extraído de un PDF. ' + PROMPT.replace('Analiza la imagen. ', '')

/** Tope de texto de un PDF que se manda a la IA (un comprobante cabe de sobra). */
const MAX_TEXTO_PDF = 12_000

async function preguntarIa(
  accountId: string,
  contenido: string | { type: string; text?: string; image_url?: { url: string } }[],
): Promise<LecturaComprobante | null> {
  const db = supabaseAdmin()
  const cfg = await loadAiConfig(db, accountId)
  if (!cfg || cfg.provider === 'anthropic') return null
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: contenido }],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`visión ${res.status}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const txt = data.choices?.[0]?.message?.content ?? ''
  const json = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)
  return json ? (JSON.parse(json) as LecturaComprobante) : null
}

async function leerConIa(accountId: string, imagen: Buffer, mime: string): Promise<LecturaComprobante | null> {
  return preguntarIa(accountId, [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${imagen.toString('base64')}` } },
  ])
}

/** Texto de un PDF (todas las páginas juntas). Exportado para pruebas. */
export async function textoDePdf(pdf: Buffer | Uint8Array): Promise<string> {
  const { extractText } = await import('unpdf')
  const { text } = await extractText(new Uint8Array(pdf), { mergePages: true })
  return text.replace(/\s+/g, ' ').trim()
}

async function leerPdfConIa(accountId: string, pdf: Buffer): Promise<LecturaComprobante | null> {
  const texto = (await textoDePdf(pdf)).slice(0, MAX_TEXTO_PDF)
  // PDF escaneado (sin texto): no hay nada que leer, se revisa a mano.
  if (texto.length < 20) return null
  return preguntarIa(accountId, `${PROMPT_PDF}\n\nTEXTO DEL PDF:\n${texto}`)
}

/** ¿Este archivo es algo que el lector sabe leer? */
export function esComprobanteLegible(mime: string): boolean {
  const m = mime.split(';')[0].trim().toLowerCase()
  return m.startsWith('image/') || m === 'application/pdf'
}

/**
 * Lee un comprobante (imagen o PDF) recibido por WhatsApp. Lo usan el
 * lector de siempre (`procesarComprobante`) y el nodo Botón Pago / SPEI
 * del Flow Builder. Devuelve null si no se pudo leer (archivo muy pesado,
 * PDF escaneado sin texto o la IA no contestó). Nunca lanza.
 */
export async function leerComprobanteDeMedio(args: {
  accountId: string
  mediaId: string
  mime: string
  accessToken: string
}): Promise<LecturaComprobante | null> {
  try {
    if (!esComprobanteLegible(args.mime)) return null
    const { url, fileSize } = await getMediaUrl({ mediaId: args.mediaId, accessToken: args.accessToken })
    if (fileSize != null && fileSize > MAX_BYTES) return null
    const { buffer, contentType } = await downloadMedia({ downloadUrl: url, accessToken: args.accessToken })
    const tipo = (contentType.split(';')[0] || args.mime).toLowerCase()
    if (tipo === 'application/pdf' || args.mime.toLowerCase().startsWith('application/pdf')) {
      return await leerPdfConIa(args.accountId, buffer)
    }
    return await leerConIa(args.accountId, buffer, tipo || args.mime)
  } catch (e) {
    console.warn('[comprobante] lectura falló:', e instanceof Error ? e.message : e)
    return null
  }
}

/** Últimos 4 dígitos de una CLABE, tarjeta o cuenta. */
export function ultimos4(cuenta: string | null | undefined): string {
  return (cuenta ?? '').replace(/\D/g, '').slice(-4)
}

/** Pone una etiqueta por nombre (la crea si no existe) y dispara sus automatizaciones. */
export async function etiquetar(accountId: string, userId: string, contactId: string, nombre: string) {
  const db = supabaseAdmin()
  let { data: tag } = await db.from('tags').select('id').eq('account_id', accountId).eq('name', nombre).maybeSingle()
  if (!tag) {
    const { data } = await db.from('tags').insert({ name: nombre, color: '#D9962B', account_id: accountId, user_id: userId }).select('id').single()
    tag = data
  }
  if (tag) await addContactTagAndDispatch({ db, accountId, contactId, tagId: tag.id })
}

/** Nombres de las etiquetas del contacto (una consulta). */
export async function etiquetasDelContacto(db: SupabaseClient, contactId: string): Promise<string[]> {
  const { data: filas } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId)
  return (filas ?? [])
    .map((f) => (f as unknown as { tags: { name: string } | null }).tags?.name)
    .filter(Boolean) as string[]
}

/**
 * ¿Este contacto tiene un pago pendiente de verificar? Es la condición que
 * dispara el lector de comprobantes y la que apaga la lectura genérica de
 * imágenes (para no pagar dos veces por la misma foto).
 */
export async function tienePagoPendiente(db: SupabaseClient, contactId: string): Promise<boolean> {
  const nombres = await etiquetasDelContacto(db, contactId)
  return nombres.some((n) => ETIQUETAS_PENDIENTE.includes(n))
}

export async function procesarComprobante(args: {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  message: { type: string; image?: { id: string; mime_type: string }; document?: { id: string; mime_type: string } }
  accessToken: string
}): Promise<void> {
  try {
    const media = args.message.type === 'image' ? args.message.image : args.message.type === 'document' ? args.message.document : undefined
    if (!media) return
    const db = supabaseAdmin()

    const nombres = await etiquetasDelContacto(db, args.contactId)
    if (!nombres.some((n) => ETIQUETAS_PENDIENTE.includes(n))) return

    const enviar = (text: string) =>
      engineSendText({ accountId: args.accountId, userId: args.userId, conversationId: args.conversationId, contactId: args.contactId, text })

    // Imagen o PDF (desde el 22-nov-2026 también se leen los PDF).
    const lectura = await leerComprobanteDeMedio({
      accountId: args.accountId,
      mediaId: media.id,
      mime: media.mime_type,
      accessToken: args.accessToken,
    })

    // Imagen que claramente no es un comprobante: se le pide la correcta.
    if (lectura && !lectura.es_comprobante) {
      await enviar('Mmm 🤔 esa imagen no parece un comprobante de pago.\n\n¿Me mandas la *captura de tu transferencia* o la *foto de tu ticket del OXXO*? 📸')
      return
    }

    const montoTxt = lectura?.monto ? ` de *$${Number(lectura.monto).toLocaleString('es-MX')}*` : ''
    await enviar(`📸 ¡Recibí tu comprobante${montoTxt}! 🙌\n\nLo estoy verificando y en cuanto se confirme te llega todo por aquí 🎁 (normalmente en minutos, en horario de día).`)

    const evaluado = lectura
      ? evaluarComprobante(lectura, lista(process.env.COMPROBANTE_DIGITOS), lista(process.env.COMPROBANTE_MONTOS).map(Number))
      : { ok: false, motivos: ['no se pudo leer (PDF o imagen muy pesada): revisar a mano'] }
    // Antifraude: la misma referencia ya apareció en otro comprobante → no se aprueba sola.
    const ref = (lectura?.referencia ?? '').trim()
    if (ref.length >= 5) {
      const { count } = await db
        .from('contact_notes')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', args.accountId)
        .ilike('note_text', `%Referencia: ${ref.replace(/[%_]/g, '')}%`)
      if ((count ?? 0) > 0) {
        evaluado.ok = false
        evaluado.motivos.push(`referencia ${ref} repetida (ya se usó en otro comprobante)`)
      }
    }
    const { ok, motivos } = evaluado

    const nota = lectura
      ? `🧾 Comprobante leído por IA — ${ok ? '✅ COINCIDE' : '⚠️ REVISAR: ' + motivos.join('; ')}\n` +
        `Monto: ${lectura.monto ?? '?'} · Banco destino: ${lectura.banco_destino ?? '?'} · Destino …${lectura.ultimos_digitos_destino ?? '?'} · ` +
        `Estado: ${lectura.estado ?? '?'} · Tipo: ${lectura.tipo ?? '?'} · Fecha: ${lectura.fecha ?? '?'} · Referencia: ${lectura.referencia ?? '?'}\n` +
        (ok && process.env.COMPROBANTE_AUTO_PAGADO === 'on'
          ? 'Aprobado automáticamente. Revisa en tu app de Mercado Pago que el dinero sí llegó.'
          : 'Confirma en tu app de Mercado Pago antes de poner «pagado».')
      : `🧾 Llegó un comprobante que la IA no pudo leer (${motivos.join('; ')}). Revísalo a mano.`
    await db.from('contact_notes').insert({ contact_id: args.contactId, user_id: args.userId, account_id: args.accountId, note_text: nota })

    await etiquetar(args.accountId, args.userId, args.contactId, 'comprobante-recibido')
    await etiquetar(args.accountId, args.userId, args.contactId, ok ? 'comprobante-ok' : 'comprobante-revisar')
    if (ok && process.env.COMPROBANTE_AUTO_PAGADO === 'on') {
      if (lectura?.monto) await guardarValor(args.accountId, args.userId, args.contactId, 'monto_pagado', String(lectura.monto))
      // Pedido principal → «pagado» (bonos + post-compra); complemento → «extra-pagado» (apaga recordatorios).
      if (nombres.includes('pago-por-verificar') && !nombres.includes('pagado')) {
        await etiquetar(args.accountId, args.userId, args.contactId, 'pagado')
      } else if (nombres.includes('extra-por-verificar')) {
        await etiquetar(args.accountId, args.userId, args.contactId, 'extra-pagado')
      }
    }
  } catch (err) {
    console.error('[comprobante] falló:', err instanceof Error ? err.message : err)
  }
}
