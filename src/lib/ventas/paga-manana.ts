// «Mañana pago»: cuando una clienta escribe que paga (o se reporta) mañana, se le pone la
// etiqueta «paga-manana». Esa etiqueta dispara la automatización de cada producto que, al día
// siguiente y DENTRO de las 24 h de WhatsApp, le recuerda su pago (y le ofrece la App).
// No se marca si ya pagó todo (tiene «pagado» y no debe ningún complemento). Nunca lanza.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'

const quitarAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** ¿El mensaje dice que paga / deposita / se reporta mañana? Exportado para pruebas. */
export function diceQuePagaManana(texto: string): boolean {
  const t = quitarAcentos(texto)
  if (!/\bmanana\b/.test(t)) return false
  if (/\bmanana (no|tampoco)\b/.test(t)) return false
  return /(pag|deposit|transf|report|abon|liquid|comprobante|te (mando|envio|confirmo|aviso|escribo|hablo))/.test(t)
}

export async function marcarPagaManana(args: { accountId: string; userId: string; contactId: string; texto: string }): Promise<void> {
  try {
    if (!diceQuePagaManana(args.texto)) return
    const db = supabaseAdmin()
    const { data: filas } = await db.from('contact_tags').select('tags(name)').eq('contact_id', args.contactId)
    const tags = (filas ?? []).map((f) => (f as unknown as { tags: { name: string } | null }).tags?.name).filter(Boolean) as string[]
    if (tags.includes('pagado') && !tags.includes('extra-por-verificar')) return   // ya pagó todo
    let { data: tag } = await db.from('tags').select('id').eq('account_id', args.accountId).eq('name', 'paga-manana').maybeSingle()
    if (!tag) {
      const { data } = await db.from('tags').insert({ name: 'paga-manana', color: '#F59E0B', account_id: args.accountId, user_id: args.userId }).select('id').single()
      tag = data
    }
    if (tag) await addContactTagAndDispatch({ db, accountId: args.accountId, contactId: args.contactId, tagId: tag.id })
  } catch (err) {
    console.error('[paga-manana] falló:', err instanceof Error ? err.message : err)
  }
}
