// ============================================================
// API de conversiones para mensajes de negocios (Meta) — SCALE WHATSAPP.
//
// 1) guardarReferenciaAnuncio: cuando una clienta escribe desde un anuncio de
//    clic a WhatsApp, el webhook trae `referral.ctwa_clid` (el clic). Se guarda
//    en campos personalizados del contacto (ctwa_clid, anuncio_id, anuncio_fecha).
// 2) enviarCompraMeta: al ponerse «pagado» o «extra-pagado», se manda a Meta un
//    evento Purchase con el monto, ligado a ese clic, para que la campaña
//    aprenda quién compra.
//
// Variables de entorno:
//   META_DATASET_ID     conjunto de datos ligado a la cuenta de WhatsApp (POST /{waba}/dataset)
//   META_EVENTS_TOKEN   token con permiso whatsapp_business_manage_events
//                       (si falta, se usa el token de WhatsApp de la cuenta)
// Nunca lanza.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

const GRAPH = 'https://graph.facebook.com/v21.0'

export interface ReferenciaAnuncio {
  ctwa_clid?: string
  source_id?: string
  source_type?: string
  source_url?: string
  headline?: string
}

async function campoId(accountId: string, userId: string, nombre: string): Promise<string | null> {
  const db = supabaseAdmin()
  const { data } = await db.from('custom_fields').select('id').eq('account_id', accountId).eq('field_name', nombre).maybeSingle()
  if (data) return data.id
  const { data: nuevo } = await db.from('custom_fields')
    .insert({ account_id: accountId, user_id: userId, field_name: nombre, field_type: 'text' }).select('id').single()
  return nuevo?.id ?? null
}

export async function guardarValor(accountId: string, userId: string, contactId: string, nombre: string, valor: string) {
  const id = await campoId(accountId, userId, nombre)
  if (!id) return
  await supabaseAdmin().from('contact_custom_values')
    .upsert({ contact_id: contactId, custom_field_id: id, value: valor }, { onConflict: 'contact_id,custom_field_id' })
}

async function leerValores(accountId: string, contactId: string): Promise<Record<string, string>> {
  const db = supabaseAdmin()
  const { data } = await db.from('contact_custom_values')
    .select('value, custom_fields!inner(field_name, account_id)')
    .eq('contact_id', contactId).eq('custom_fields.account_id', accountId)
  const out: Record<string, string> = {}
  for (const f of (data ?? []) as unknown as { value: string; custom_fields: { field_name: string } }[]) out[f.custom_fields.field_name] = f.value
  return out
}

export async function guardarReferenciaAnuncio(args: {
  accountId: string; userId: string; contactId: string; referral: ReferenciaAnuncio | undefined
}): Promise<void> {
  try {
    const clid = args.referral?.ctwa_clid
    if (!clid) return
    await guardarValor(args.accountId, args.userId, args.contactId, 'ctwa_clid', clid)
    if (args.referral?.source_id) await guardarValor(args.accountId, args.userId, args.contactId, 'anuncio_id', args.referral.source_id)
    await guardarValor(args.accountId, args.userId, args.contactId, 'anuncio_fecha', new Date().toISOString())
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

export async function enviarCompraMeta(args: { accountId: string; contactId: string; etiqueta: string }): Promise<void> {
  const db = supabaseAdmin()
  const nota = async (texto: string) => {
    const { data: c } = await db.from('contacts').select('user_id').eq('id', args.contactId).maybeSingle()
    if (c) await db.from('contact_notes').insert({ contact_id: args.contactId, user_id: c.user_id, account_id: args.accountId, note_text: texto })
  }
  try {
    const dataset = process.env.META_DATASET_ID
    if (!dataset) return
    const valores = await leerValores(args.accountId, args.contactId)
    const { data: filas } = await db.from('contact_tags').select('tags(name)').eq('contact_id', args.contactId)
    const tags = (filas ?? []).map((f) => (f as unknown as { tags: { name: string } | null }).tags?.name).filter(Boolean) as string[]
    const valor = valorDeCompra(args.etiqueta, tags, valores)
    if (valores.monto_pagado) {   // se usa una sola vez: la siguiente venta se calcula de nuevo
      const { data: c } = await db.from('contacts').select('user_id').eq('id', args.contactId).maybeSingle()
      if (c) await guardarValor(args.accountId, c.user_id, args.contactId, 'monto_pagado', '')
    }
    const clid = valores.ctwa_clid
    if (!clid) {
      await nota(`📊 Venta de $${valor} sin anuncio de origen (llegó orgánica): no se envió a Meta.`)
      return
    }
    const { data: cfg } = await db.from('whatsapp_config').select('waba_id, access_token').eq('account_id', args.accountId).maybeSingle()
    if (!cfg?.waba_id) return
    const token = process.env.META_EVENTS_TOKEN || decrypt(cfg.access_token)
    const evento = {
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: `${args.contactId}-${args.etiqueta}-${new Date().toISOString().slice(0, 10)}`,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: cfg.waba_id, ctwa_clid: clid },
      custom_data: { currency: 'MXN', value: valor },
    }
    const res = await fetch(`${GRAPH}/${dataset}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [evento] }),
      signal: AbortSignal.timeout(20_000),
    })
    const cuerpo = await res.text()
    await nota(res.ok
      ? `📊 Compra de $${valor} MXN enviada a Meta (anuncio ${valores.anuncio_id ?? '?'}).`
      : `📊 Meta rechazó la compra de $${valor}: ${res.status} ${cuerpo.slice(0, 200)}`)
    if (!res.ok) console.warn('[conversiones] Meta rechazó el evento:', res.status, cuerpo.slice(0, 300))
  } catch (err) {
    console.error('[conversiones] falló:', err instanceof Error ? err.message : err)
  }
}
