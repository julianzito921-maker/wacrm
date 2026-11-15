// SOLO LECTURA: ¿la app ve esta WABA? (token de app = id|secreto de Railway; no imprime claves)
const [appId, waba] = process.argv.slice(2)
const tok = encodeURIComponent(appId + '|' + (process.env.META_APP_SECRET || '').split(',')[0])
;(async () => {
  for (const ruta of [`${waba}?fields=id,name,currency,timezone_id,message_template_namespace`, `${waba}/subscribed_apps`, `${waba}/phone_numbers?fields=display_phone_number,verified_name,status`]) {
    const j: any = await (await fetch(`https://graph.facebook.com/v23.0/${ruta}${ruta.includes('?') ? '&' : '?'}access_token=${tok}`)).json()
    console.log(ruta.split('?')[0], '→', JSON.stringify(j.error ? { error: j.error.message } : j).slice(0, 300))
  }
})()

export {}