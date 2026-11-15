// SOLO LECTURA: cuentas de WhatsApp asignadas al usuario del sistema dueño del token guardado
import { createClient as crear } from '@supabase/supabase-js'
import { loadAccountMetaCredentials } from '../src/lib/flows/meta-send'
const [accountId, ...ids] = process.argv.slice(2)
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
;(async () => {
  const { accessToken } = await loadAccountMetaCredentials(db as any, accountId)
  const g = async (p: string) => (await fetch(`https://graph.facebook.com/v23.0/${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`)).json()
  const me: any = await g('me?fields=id,name'); console.log('usuario del token:', me.name, me.id)
  for (const p of [`${me.id}/assigned_whatsapp_business_accounts?fields=id,name`, `me/assigned_whatsapp_business_accounts?fields=id,name`]) {
    const r: any = await g(p); console.log(p.split('?')[0], '→', JSON.stringify(r.data ?? r.error?.message))
    for (const w of r.data ?? []) { const n: any = await g(`${w.id}/phone_numbers?fields=id,display_phone_number,status`); console.log('   ', w.id, w.name, '→', JSON.stringify(n.data ?? n.error?.message)) }
  }
  for (const id of ids) { const n: any = await g(`${id}/phone_numbers?fields=id,display_phone_number`); console.log('prueba', id, '→', n.error ? n.error.message.slice(0, 90) : JSON.stringify(n.data)) }
})()
