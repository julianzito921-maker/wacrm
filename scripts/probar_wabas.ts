// SOLO LECTURA: prueba IDs candidatos de WABA con el token guardado (no imprime el token)
import { createClient as crear } from '@supabase/supabase-js'
import { loadAccountMetaCredentials } from '../src/lib/flows/meta-send'
const [accountId, ...ids] = process.argv.slice(2)
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
;(async () => {
  const { accessToken } = await loadAccountMetaCredentials(db as any, accountId)
  const g = async (p: string) => (await fetch(`https://graph.facebook.com/v23.0/${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`)).json()
  for (const id of ids) {
    const n: any = await g(`${id}/phone_numbers?fields=id,display_phone_number,verified_name,status`)
    console.log(id, '→', n.error ? 'error: ' + n.error.message : 'NÚMEROS: ' + JSON.stringify(n.data))
  }
  for (const e of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
    const r: any = await g(`1092897949866806/${e}?fields=id,name`)
    console.log('portafolio', e, '→', JSON.stringify(r.data ?? r.error?.message))
  }
})()
