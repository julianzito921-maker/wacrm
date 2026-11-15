// SOLO LECTURA: estado de los números y de la cuenta de WhatsApp en Meta (no cambia nada). No imprime tokens.
import { createClient as crear } from '@supabase/supabase-js'
import { loadAccountMetaCredentials } from '../src/lib/flows/meta-send'
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
;(async () => {
  const { data } = await db.from('whatsapp_config').select('account_id, phone_number_id, waba_id')
  for (const w of data ?? []) {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(db as any, w.account_id)
    const g = async (path: string) => (await fetch(`https://graph.facebook.com/v23.0/${path}`, { headers: { Authorization: 'Bearer ' + accessToken } })).json()
    const n: any = await g(`${phoneNumberId}?fields=display_phone_number,verified_name,status,name_status,quality_rating,messaging_limit_tier,account_mode,code_verification_status`)
    console.log('NÚMERO', JSON.stringify(n))
    if ((w as any).waba_id) console.log('CUENTA', JSON.stringify(await g(`${(w as any).waba_id}?fields=name,account_review_status,business_verification_status,ban_state,health_status`)))
  }
})()
