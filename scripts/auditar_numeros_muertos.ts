// SOLO LECTURA: qué queda ligado a cada número del CRM (para limpiar un número baneado o muerto). No imprime tokens.
import { createClient as crear } from '@supabase/supabase-js'
import { decrypt } from '../src/lib/whatsapp/encryption'
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const cuenta = async (t: string, f: (q: any) => any) => { const { count, error } = await f(db.from(t).select('*', { count: 'exact', head: true })); return error ? `ERR ${error.message}` : count }
const enlaces = (s: string) => Array.from(new Set((s.match(/https?:\/\/[^\s"')\]]+/g) ?? []).map((u) => u.split('/').slice(0, 3).join('/'))))
;(async () => {
  const { data } = await db.from('whatsapp_config').select('id, account_id, phone_number_id, waba_id, status, access_token, connected_at')
  for (const w of (data as any[]) ?? []) {
    let tel: any = {}
    try { tel = await (await fetch(`https://graph.facebook.com/v23.0/${w.phone_number_id}?fields=display_phone_number,verified_name,status,name_status`, { headers: { Authorization: 'Bearer ' + decrypt(w.access_token) } })).json() } catch (e) { tel = { error: String(e) } }
    const acc = w.account_id
    const { data: a } = await db.from('accounts').select('name').eq('id', acc).maybeSingle()
    console.log('\n=== CUENTA', (a as any)?.name, acc, '| config', w.status, '| phone', w.phone_number_id, '| waba', w.waba_id)
    console.log('Meta:', JSON.stringify(tel.error ? { error: tel.error.message ?? tel.error } : tel))
    console.log('contactos', await cuenta('contacts', (q) => q.eq('account_id', acc)), '| conversaciones', await cuenta('conversations', (q) => q.eq('account_id', acc)))
    console.log('esperas pendientes', await cuenta('automation_pending_executions', (q) => q.eq('account_id', acc).in('status', ['pending', 'awaiting_reply', 'running'])))
    console.log('cola pendiente', await cuenta('outbound_message_queue', (q) => q.eq('account_id', acc).in('status', ['PENDING', 'PROCESSING'])))
    const { data: flows } = await db.from('flows').select('id, name, status').eq('account_id', acc)
    const activos = ((flows as any[]) ?? []).filter((f) => f.status === 'active')
    console.log('flujos activos', activos.map((f) => f.name).join(' · ') || '—')
    if (activos.length) console.log('corridas activas', await cuenta('flow_runs', (q) => q.in('flow_id', activos.map((f) => f.id)).eq('status', 'active')))
    const { data: autos } = await db.from('automations').select('name, is_active, trigger_type').eq('account_id', acc).eq('is_active', true)
    console.log('automatizaciones activas', ((autos as any[]) ?? []).map((x) => `${x.name} [${x.trigger_type}]`).join(' · ') || '—')
    const { data: ai } = await db.from('ai_configs').select('*').eq('account_id', acc).maybeSingle()
    if (ai) { const p = JSON.stringify(ai); console.log('IA activa', (ai as any).enabled ?? (ai as any).is_enabled, '| dominios en prompt/archivos:', enlaces(p).join(' ') || '—') }
    const { data: nodos } = await db.from('flow_nodes').select('config').in('flow_id', ((flows as any[]) ?? []).map((f) => f.id))
    console.log('dominios en flujos:', enlaces(JSON.stringify(nodos ?? [])).join(' ') || '—')
    console.log('plantillas', await cuenta('message_templates', (q) => q.eq('account_id', acc)))
  }
})()
