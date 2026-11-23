// ============================================================
// API de conversiones para mensajes de negocios (Meta) — SCALE WHATSAPP.
//
// 1) guardarReferenciaAnuncio: cuando una clienta escribe desde un anuncio de
//    clic a WhatsApp, el webhook trae `referral.ctwa_clid` (el clic). Se guarda
//    en `contact_attribution` y en los campos personalizados de siempre
//    (ctwa_clid, anuncio_id, anuncio_fecha).
// 2) enviarCompraMeta: al ponerse «pagado» o «extra-pagado», se manda a Meta un
//    evento Purchase con el monto, ligado a ese clic, para que la campaña
//    aprenda quién compra.
//
// Credenciales, en orden:
//   1. Píxel Meta activo de la cuenta en `tracking_pixels` (token cifrado,
//      test_event_code opcional).
//   2. Respaldo por entorno: META_DATASET_ID + META_EVENTS_TOKEN.
//   3. Token de WhatsApp de la cuenta si no hay token de eventos.
//
// Nunca lanza.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { guardarValor, leerValores } from './contact-values'
import { leerAtribucion, upsertContactAttribution } from '@/lib/tracking/attribution'
import { monedaDeCuenta, resolverCredencialesConexion } from '@/lib/tracking/pixels'
import { parametrosDeUrl } from '@/lib/tracking/links'

// Compatibilidad: el motor de flujos importa `guardarValor` desde aquí.
export { guardarValor } from './contact-values'

const GRAPH = 'https://graph.facebook.com/v21.0'

export interface ReferenciaAnuncio {
  ctwa_clid?: string
  source_id?: string
  source_type?: string
  source_url?: string
  headline?: string
}

export async function guardarReferenciaAnuncio(args: {
  accountId: string
  userId: string
  contactId: string
  connectionId?: string | null
  referral: ReferenciaAnuncio | undefined
}): Promise<void> {
  try {
    const clid = args.referral?.ctwa_clid
    if (!clid) return
    // Compatibilidad con CAPI y el inbox (antes de existir la tabla).
    await guardarValor(args.accountId, args.userId, args.contactId, 'ctwa_clid', clid)
    if (args.referral?.source_id) {
      await guardarValor(args.accountId, args.userId, args.contactId, 'anuncio_id', args.referral.source_id)
    }
    await guardarValor(
      args.accountId,
      args.userId,
      args.contactId,
      'anuncio_fecha',
      new Date().toISOString(),
    )
    await upsertContactAttribution({
      accountId: args.accountId,
      userId: null, // los campos ya se escribieron arriba
      contactId: args.contactId,
      connectionId: args.connectionId ?? null,
      source: 'meta',
      ctwaClid: clid,
      ad: args.referral?.source_id ?? null,
      utm: parametrosDeUrl(args.referral?.source_url),
      raw: { ...args.referral },
    })
  } catch (err) {
    console.error('[conversiones] no se pudo guardar el anuncio:', err instanceof Error ? err.message : err)
  }
}

/** Monto de la venta. Exportado para pruebas. */
export function valorDeCompra(etiqueta: string, tags: string[], valores: Record<string, string>): number {
  const leido = Number(valores.monto_pagado)
  if (Number.isFinite(leido) && leido > 0) return leido            // lo que leyó el lector de comprobantes
  if (etiqueta === 'extra-pagado') return Number(valores.monto_pendiente) || 0
  if (tags.includes('compro-59')) return 59
  return 99 + (tags.includes('quiere-antojos') ? 69 : 0) + (tags.includes('quiere-menopausia') ? 69 : 0)
    + (tags.includes('quiere-recetario') ? 49 : 0) + (tags.includes('quiere-ligas') ? 49 : 0)   // order bumps de Glúteos
}

/** Arma el evento de Meta CAPI (business_messaging). Exportado para pruebas. */
export function armarEventoMeta(args: {
  eventName: string; eventId: string; wabaId: string; ctwaClid: string
  value?: number; currency?: string; pageId?: string; ahora?: Date
}) {
  const valor = Number(args.value)
  const base: Record<string, unknown> = Number.isFinite(valor) && valor > 0
    ? { currency: args.currency || 'MXN', value: valor }
    : { currency: args.currency || 'MXN' }
  if (args.pageId) base.page_id = args.pageId
  return {
    event_name: args.eventName,
    event_time: Math.floor((args.ahora ?? new Date()).getTime() / 1000),
    event_id: args.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: args.wabaId, ctwa_clid: args.ctwaClid },
    custom_data: base,
  }
}

export type ResultadoEventoMeta =
  | { enviado: true }
  | {
      enviado: false
      motivo: 'sin_pixel' | 'sin_conexion' | 'sin_token' | 'sin_anuncio' | 'sin_waba' | 'rechazado' | 'error'
      detalle?: string
    }

/**
 * Manda un evento a Meta ligado al clic del anuncio de la clienta. Deja una
 * nota «📊» en el contacto. Nunca lanza: devuelve qué pasó.
 */
export async function enviarEventoMeta(args: {
  accountId: string; contactId: string; eventName: string; eventId: string
  value?: number; currency?: string
  /** Isla concreta: obligatoria cuando hay más de una conexión. */
  connectionId?: string | null
  /** Alternativa: resolver la isla desde el hilo. */
  conversationId?: string | null
  /** Píxel/dataset concreto del nodo (opcional). */
  pixelId?: string
  /** Page ID de referencia (opcional; no cambia el dataset). */
  pageId?: string
  /** Valores ya leídos (para no consultarlos dos veces). */
  valores?: Record<string, string>
}): Promise<ResultadoEventoMeta> {
  const db = supabaseAdmin()
  const nota = async (texto: string) => {
    const { data: c } = await db.from('contacts').select('user_id').eq('id', args.contactId).maybeSingle()
    if (c) await db.from('contact_notes').insert({ contact_id: args.contactId, user_id: c.user_id, account_id: args.accountId, note_text: texto })
  }
  try {
    const moneda = args.currency || await monedaDeCuenta(args.accountId)
    const monto = Number(args.value) > 0 ? ` de $${args.value} ${moneda}` : ''

    // Resolver la isla antes del píxel. Nunca se cae a "la primera" si
    // hay varias conexiones: eso mezclaría tokens/píxeles.
    let connectionId = args.connectionId ?? null
    if (!connectionId && args.conversationId) {
      const { data: conv } = await db
        .from('conversations')
        .select('connection_id')
        .eq('id', args.conversationId)
        .eq('account_id', args.accountId)
        .maybeSingle()
      connectionId = (conv as { connection_id?: string | null } | null)?.connection_id ?? null
    }
    if (!connectionId) {
      const { data: conexiones } = await db
        .from('whatsapp_connections')
        .select('id')
        .eq('account_id', args.accountId)
        .eq('active', true)
        .limit(2)
      const lista = (conexiones ?? []) as Array<{ id: string }>
      if (lista.length !== 1) return { enviado: false, motivo: 'sin_conexion' }
      connectionId = lista[0].id
    }

    const creds = await resolverCredencialesConexion(
      args.accountId,
      connectionId,
      args.pixelId,
    )
    if (!creds) return { enviado: false, motivo: 'sin_pixel' }

    const valores = args.valores ?? await leerValores(args.accountId, args.contactId)
    const atribucion = await leerAtribucion(args.accountId, args.contactId, connectionId)
    // Con isla, solo vale la atribución de esa isla. El campo legacy del
    // contacto podría venir de otra isla y no se usa.
    const clid = atribucion?.ctwa_clid ?? (connectionId ? null : valores.ctwa_clid)
    if (!clid) {
      await nota(`📊 ${args.eventName}${monto} sin anuncio de origen (llegó orgánica): no se envió a Meta.`)
      return { enviado: false, motivo: 'sin_anuncio' }
    }

    const wabaId = creds.wabaId
    const token = creds.token || creds.wabaToken
    if (!wabaId) return { enviado: false, motivo: 'sin_waba' }
    if (!token) return { enviado: false, motivo: 'sin_token' }

    const evento = armarEventoMeta({
      eventName: args.eventName,
      eventId: args.eventId,
      wabaId: wabaId,
      ctwaClid: clid,
      value: args.value,
      currency: moneda,
      pageId: args.pageId,
    })
    const qs = creds.testEventCode
      ? `?test_event_code=${encodeURIComponent(creds.testEventCode)}`
      : ''
    const res = await fetch(`${GRAPH}/${creds.pixelId}/events${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [evento] }),
      signal: AbortSignal.timeout(20_000),
    })
    const cuerpo = await res.text()
    await nota(res.ok
      ? `📊 ${args.eventName}${monto} enviado a Meta (anuncio ${valores.anuncio_id ?? '?'}).`
      : `📊 Meta rechazó ${args.eventName}${monto}: ${res.status} ${cuerpo.slice(0, 200)}`)
    if (!res.ok) {
      console.warn('[conversiones] Meta rechazó el evento:', res.status, cuerpo.slice(0, 300))
      return { enviado: false, motivo: 'rechazado', detalle: `${res.status}` }
    }
    return { enviado: true }
  } catch (err) {
    console.error('[conversiones] falló:', err instanceof Error ? err.message : err)
    return { enviado: false, motivo: 'error', detalle: err instanceof Error ? err.message : String(err) }
  }
}

export async function enviarCompraMeta(args: {
  accountId: string
  contactId: string
  etiqueta: string
  connectionId?: string | null
  conversationId?: string | null
}): Promise<void> {
  const db = supabaseAdmin()
  try {
    let connectionId = args.connectionId ?? null
    if (!connectionId && args.conversationId) {
      const { data: conv } = await db
        .from('conversations')
        .select('connection_id')
        .eq('id', args.conversationId)
        .eq('account_id', args.accountId)
        .maybeSingle()
      connectionId = (conv as { connection_id?: string | null } | null)?.connection_id ?? null
    }
    if (!connectionId) {
      const { data: conv } = await db
        .from('conversations')
        .select('connection_id')
        .eq('account_id', args.accountId)
        .eq('contact_id', args.contactId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      connectionId = (conv as { connection_id?: string | null } | null)?.connection_id ?? null
    }
    const valores = await leerValores(args.accountId, args.contactId)
    const { data: filas } = await db.from('contact_tags').select('tags(name)').eq('contact_id', args.contactId)
    const tags = (filas ?? []).map((f) => (f as unknown as { tags: { name: string } | null }).tags?.name).filter(Boolean) as string[]
    const valor = valorDeCompra(args.etiqueta, tags, valores)
    if (valores.monto_pagado) {   // se usa una sola vez: la siguiente venta se calcula de nuevo
      const { data: c } = await db.from('contacts').select('user_id').eq('id', args.contactId).maybeSingle()
      if (c) await guardarValor(args.accountId, c.user_id, args.contactId, 'monto_pagado', '')
    }
    await enviarEventoMeta({
      accountId: args.accountId,
      contactId: args.contactId,
      connectionId,
      eventName: 'Purchase',
      eventId: `${args.contactId}-${args.etiqueta}-${new Date().toISOString().slice(0, 10)}`,
      value: valor,
      currency: await monedaDeCuenta(args.accountId),
      valores,
    })
  } catch (err) {
    console.error('[conversiones] falló:', err instanceof Error ? err.message : err)
  }
}
