// Saldo de DeepSeek de cada cuenta del CRM (no imprime claves). Uso: railway run --service wacrm npx tsx --tsconfig tsconfig.json scripts/saldo_deepseek.ts
import { createClient as crear } from '@supabase/supabase-js'
import { loadAiConfig } from '../src/lib/ai/config'
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
;(async () => {
  const { data } = await db.from('whatsapp_config').select('account_id, phone_number_id')
  const vistas = new Set<string>()
  for (const w of data ?? []) {
    const cfg = await loadAiConfig(db as any, w.account_id)
    if (!cfg?.apiKey || vistas.has(cfg.apiKey)) continue
    vistas.add(cfg.apiKey)
    const r = await fetch((cfg.baseUrl || 'https://api.deepseek.com') + '/user/balance', { headers: { Authorization: 'Bearer ' + cfg.apiKey } })
    const j: any = await r.json()
    console.log(w.phone_number_id, '→', JSON.stringify(j.balance_infos ?? j))
  }
})()
