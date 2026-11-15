// SOLO LECTURA: ¿qué cuenta(s) de WhatsApp Business administra el token guardado de una cuenta del CRM? (no imprime el token)
import { createClient as crear } from '@supabase/supabase-js'
import { loadAccountMetaCredentials } from '../src/lib/flows/meta-send'
const [accountId, appId] = process.argv.slice(2)
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
;(async () => {
  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(db as any, accountId)
  console.log('número guardado:', phoneNumberId)
  const app = encodeURIComponent(appId + '|' + (process.env.META_APP_SECRET || '').split(',')[0])
  const d: any = await (await fetch(`https://graph.facebook.com/v23.0/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${app}`)).json()
  const info = d.data || {}
  console.log('token válido:', info.is_valid, '· app:', info.app_id, '· caduca:', info.expires_at === 0 ? 'nunca' : info.expires_at, '· permisos:', (info.scopes || []).join(', '))
  const wabas = new Set<string>()
  for (const g of info.granular_scopes || []) { console.log('  ', g.scope, '→', (g.target_ids || []).join(', ') || '(todos)'); if (g.scope === 'whatsapp_business_management') (g.target_ids || []).forEach((x: string) => wabas.add(x)) }
  for (const w of wabas) {
    const j: any = await (await fetch(`https://graph.facebook.com/v23.0/${w}?fields=id,name&access_token=${encodeURIComponent(accessToken)}`)).json()
    const n: any = await (await fetch(`https://graph.facebook.com/v23.0/${w}/phone_numbers?fields=id,display_phone_number,verified_name,status&access_token=${encodeURIComponent(accessToken)}`)).json()
    console.log('WABA', w, '·', j.name ?? j.error?.message, '· números:', JSON.stringify(n.data ?? n.error?.message))
  }
})()
