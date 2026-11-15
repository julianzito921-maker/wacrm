// SOLO LECTURA: suscripciones de webhook de una app de Meta (usa META_APP_SECRET de Railway; no imprime claves).
const appId = process.argv[2]
const secretos = (process.env.META_APP_SECRET || '').split(',').filter(Boolean)
;(async () => {
  for (const [i, s] of secretos.entries()) {
    const r = await fetch(`https://graph.facebook.com/v23.0/${appId}/subscriptions?access_token=${encodeURIComponent(appId + '|' + s)}`)
    const j: any = await r.json()
    if (j.error) { console.log(`clave ${i + 1}: NO corresponde a esta app (${j.error.message})`); continue }
    console.log(`clave ${i + 1}: SÍ corresponde a la app ${appId}`)
    for (const sub of j.data ?? []) console.log(' ', sub.object, '· activo:', sub.active, '· url:', sub.callback_url, '· campos:', (sub.fields ?? []).map((f: any) => f.name).join(', '))
    if (!(j.data ?? []).length) console.log('  (sin suscripciones de webhook)')
    const a: any = await (await fetch(`https://graph.facebook.com/v23.0/${appId}?fields=name&access_token=${encodeURIComponent(appId + '|' + s)}`)).json()
    console.log('  nombre de la app:', a.name ?? a.error?.message)
  }
})()

export {}