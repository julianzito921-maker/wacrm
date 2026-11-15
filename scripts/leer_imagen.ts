/**
 * Prueba de la lectura de imágenes (Etapa 2) contra el proveedor real.
 *
 * Uso:
 *   npx tsx scripts/leer_imagen.ts <url-de-la-imagen> [phone_number_id]
 *
 * Sirve para verificar que el modelo configurado ve la imagen, cuánto tarda y
 * cuántos tokens gasta. No escribe en la base salvo el registro de uso.
 */
import { createClient } from '@supabase/supabase-js'
import { loadAiConfig } from '../src/lib/ai/config'
import { leerImagen } from '../src/lib/ai/comprension/vision'

const [, , url, phone = '1465685913294434'] = process.argv

if (!url) {
  console.error('falta la URL de la imagen')
  process.exit(1)
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

;(async () => {
  const { data } = await db.from('whatsapp_config').select('account_id').eq('phone_number_id', phone).single()
  if (!data) {
    console.error('no hay cuenta para ese número')
    process.exit(1)
  }
  const config = await loadAiConfig(db, data.account_id)
  console.log(`orquestador: ${config?.orquestador ? 'encendido' : 'APAGADO'} · modelo de visión: ${config?.visionModel ?? config?.model}`)

  const lectura = await leerImagen({ db, accountId: data.account_id, config, mediaUrl: url })
  if (!lectura) {
    console.log('sin lectura (revisa que el orquestador esté encendido y el proveedor acepte imágenes)')
    return
  }
  console.log(`clase: ${lectura.clase}`)
  console.log(`resumen: ${lectura.resumen}`)
  console.log(`modelo: ${lectura.modelo} · ${lectura.latencyMs} ms${lectura.cacheada ? ' · de caché' : ''}`)
})()
