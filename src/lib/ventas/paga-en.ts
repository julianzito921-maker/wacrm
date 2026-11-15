// «Pago en 3 horas» / «a las 5 pago»: la clienta dice CUÁNDO va a pagar (hoy). Se guarda esa hora en
// el campo «recordar_pago» y el cron interno (cada minuto) le escribe a esa hora exacta para preguntarle
// si todo bien con su pago. «Mañana» lo maneja paga-manana.ts. Solo dentro de las 24 h. Nunca lanza.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'

const ZONA = 'America/Mexico_City'
const CAMPO = 'recordar_pago'
const MIN_MS = 10 * 60_000
const MAX_MS = 23 * 3_600_000
const VENTANA_MS = 23.5 * 3_600_000

export const TEXTO_RECORDATORIO =
  'Hola 😊 ¿Todo bien con tu pago? Si ya lo hiciste, mándame aquí la *foto de tu comprobante* 📸 y te lo confirmo al momento.\n\n' +
  'Si necesitas otra vez los datos para transferir o depositar, dime y te los paso 💚'

const quitarAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const NUM: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40 }
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s] ?? NaN)
const PALABRAS_PAGO = /(pag|deposit|transf|abon|liquid|comprobante|oxxo|banco|te (mando|envio|confirmo|aviso|escribo))/

/** Hora y minutos «de reloj» en México para una fecha. */
function relojMx(d: Date): { h: number; m: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(p.find((x) => x.type === 'hour')?.value) % 24
  return { h, m: Number(p.find((x) => x.type === 'minute')?.value) }
}

/**
 * ¿Para cuándo (hoy) dice que paga? Devuelve la fecha del recordatorio o null.
 * `conPedido`: la clienta tiene un pago pendiente (así basta con «que sea en 3 horas»).
 * Exportado para pruebas.
 */
export function cuandoPaga(texto: string, ahora: Date, conPedido: boolean): Date | null {
  const t = quitarAcentos(texto).replace(/(\d)(horas?|hrs?|min)/g, '$1 $2')
  if (/\bmanana\b/.test(t)) return null // lo maneja paga-manana
  const pago = PALABRAS_PAGO.test(t)
  if (!pago && !conPedido) return null
  let ms: number | null = null

  // Relativo: «en 3 horas», «que sea 2 hrs», «en media hora», «en hora y media», «en 40 minutos».
  const guia = '(?:en|dentro de|que sea|que sean|como en|unas?|despues de|mas tardar en|ahorita en|al rato en)\\s+(?:unas?\\s+|como\\s+)?'
  const nums = '(\\d+|una?|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte|treinta|cuarenta)'
  let m: RegExpMatchArray | null
  if (/\ba las \d/.test(t)) { /* hora de reloj: abajo */ }
  else if (/\b(en|dentro de|que sea|como en) (una )?hora y media\b/.test(t)) ms = 90 * 60_000
  else if (/\b(en|dentro de|que sea|como en) (una )?media hora\b/.test(t)) ms = 30 * 60_000
  else if ((m = t.match(new RegExp(`\\b${guia}${nums}\\s*(?:horas?|hrs?|h)\\b(\\s*y media)?`)))) ms = num(m[1]) * 3_600_000 + (m[2] ? 30 * 60_000 : 0)
  else if ((m = t.match(new RegExp(`\\b${guia}${nums}\\s*(?:minutos?|mins?)\\b`)))) ms = num(m[1]) * 60_000
  else if (pago && (m = t.match(new RegExp(`\\b${nums}\\s*(?:horas?|hrs?)\\b`))) && !/\b(hace|llevo|tengo|desde)\b/.test(t)) ms = num(m[1]) * 3_600_000

  // Hora de reloj: «a las 5», «a las 5:30», «a las 17 hrs», «a las 6 de la tarde», «como a las 4 pm».
  if (ms === null && (m = t.match(/\ba las (\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?|de la manana|de la tarde|de la noche|hrs?|horas)?/))) {
    let h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    const suf = m[3] ?? ''
    if (h > 23 || min > 59) return null
    const ya = relojMx(ahora)
    const ahoraMin = ya.h * 60 + ya.m
    if (/p|tarde|noche/.test(suf) && h < 12) h += 12
    else if (!/a|manana/.test(suf) && h < 12 && h * 60 + min <= ahoraMin) h += 12 // «a las 5» dicho a las 2 p. m. = 17:00
    const delta = h * 60 + min - ahoraMin
    ms = delta * 60_000
  }

  if (ms === null || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return null
  return new Date(ahora.getTime() + ms)
}

async function etiquetas(db: ReturnType<typeof supabaseAdmin>, contactId: string): Promise<string[]> {
  const { data } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId)
  return (data ?? []).map((f) => (f as unknown as { tags: { name: string } | null }).tags?.name).filter(Boolean) as string[]
}

const yaPagoTodo = (tags: string[]) => tags.includes('pagado') && !tags.includes('extra-por-verificar')
const tienePedido = (tags: string[]) => tags.includes('pago-por-verificar') || tags.includes('extra-por-verificar')

async function campoId(db: ReturnType<typeof supabaseAdmin>, accountId: string, userId: string): Promise<string | null> {
  const { data } = await db.from('custom_fields').select('id').eq('account_id', accountId).eq('field_name', CAMPO).maybeSingle()
  if (data) return data.id
  const { data: nuevo } = await db.from('custom_fields').insert({ field_name: CAMPO, field_type: 'text', account_id: accountId, user_id: userId }).select('id').single()
  return nuevo?.id ?? null
}

/** Si el mensaje dice cuándo paga (hoy), agenda el recordatorio a esa hora. Nunca lanza. */
export async function agendarRecordatorioPago(args: { accountId: string; userId: string; contactId: string; texto: string }): Promise<void> {
  try {
    const db = supabaseAdmin()
    const tags = await etiquetas(db, args.contactId)
    if (yaPagoTodo(tags)) return
    const cuando = cuandoPaga(args.texto, new Date(), tienePedido(tags))
    if (!cuando) return
    const id = await campoId(db, args.accountId, args.userId)
    if (!id) return
    await db.from('contact_custom_values').upsert(
      { contact_id: args.contactId, custom_field_id: id, value: cuando.toISOString() },
      { onConflict: 'contact_id,custom_field_id' },
    )
  } catch (err) {
    console.error('[paga-en] no se pudo agendar:', err instanceof Error ? err.message : err)
  }
}

/** Manda los recordatorios cuya hora ya llegó. Lo llama el cron interno cada minuto. */
export async function enviarRecordatoriosVencidos(): Promise<{ enviados: number; saltados: number }> {
  const res = { enviados: 0, saltados: 0 }
  const db = supabaseAdmin()
  const { data: campos } = await db.from('custom_fields').select('id, account_id').eq('field_name', CAMPO)
  if (!campos?.length) return res
  const cuentaDe = new Map(campos.map((c) => [c.id as string, c.account_id as string]))
  const { data: vencidos } = await db
    .from('contact_custom_values')
    .select('id, contact_id, custom_field_id, value, created_at')
    .in('custom_field_id', [...cuentaDe.keys()])
    .neq('value', '')
    .lte('value', new Date().toISOString())
    .limit(50)

  for (const v of vencidos ?? []) {
    // Se borra primero: si dos procesos lo ven a la vez, solo uno lo manda.
    const { data: tomado } = await db.from('contact_custom_values').delete().eq('id', v.id).eq('value', v.value).select('id')
    if (!tomado?.length) continue
    try {
      const accountId = cuentaDe.get(v.custom_field_id)!
      if (yaPagoTodo(await etiquetas(db, v.contact_id))) { res.saltados++; continue }
      const { data: conv } = await db.from('conversations').select('id, assigned_agent_id').eq('account_id', accountId).eq('contact_id', v.contact_id).order('updated_at', { ascending: false }).limit(1).maybeSingle()
      if (!conv || conv.assigned_agent_id) { res.saltados++; continue }
      const { data: ultimos } = await db.from('messages').select('content_type, created_at').eq('conversation_id', conv.id).eq('sender_type', 'customer').order('created_at', { ascending: false }).limit(5)
      const ultimo = ultimos?.[0]
      if (!ultimo || Date.now() - new Date(ultimo.created_at).getTime() > VENTANA_MS) { res.saltados++; continue } // fuera de las 24 h
      // Si después de agendar mandó una foto o documento, es el comprobante: no se le recuerda.
      const desde = new Date(v.created_at).getTime()
      if ((ultimos ?? []).some((m) => ['image', 'document'].includes(m.content_type) && new Date(m.created_at).getTime() > desde)) { res.saltados++; continue }
      const { data: cfg } = await db.from('whatsapp_config').select('user_id').eq('account_id', accountId).limit(1).maybeSingle()
      if (!cfg) { res.saltados++; continue }
      await engineSendText({ accountId, userId: cfg.user_id, conversationId: conv.id, contactId: v.contact_id, text: TEXTO_RECORDATORIO, aiGenerated: true })
      await db.from('contact_notes').insert({ contact_id: v.contact_id, user_id: cfg.user_id, account_id: accountId,
        note_text: '⏰ Recordatorio de pago enviado a la hora que ella dijo.' })
      res.enviados++
    } catch (err) {
      res.saltados++
      console.error('[paga-en] recordatorio falló:', err instanceof Error ? err.message : err)
    }
  }
  return res
}
