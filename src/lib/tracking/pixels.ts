import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

export interface CredencialesMeta {
  pixelId: string
  /** null → usar el token de entorno o el de WhatsApp. */
  token: string | null
  testEventCode?: string
  origen: 'pixel' | 'env'
}

export interface PixelMetaGuardado {
  pixel_id: string | null
  /** Ya descifrado por el llamador. */
  access_token: string | null
  test_event_code: string | null
}

export interface EnvMeta {
  dataset?: string | null
  token?: string | null
}

/**
 * Elección pura (testeable) entre el píxel de la cuenta y el respaldo
 * por variables de entorno. El píxel gana; si no trae token se usará el
 * de entorno o, más abajo, el de WhatsApp.
 */
export function elegirCredenciales(
  pixel: PixelMetaGuardado | null,
  env: EnvMeta,
): CredencialesMeta | null {
  if (pixel?.pixel_id) {
    return {
      pixelId: pixel.pixel_id,
      token: pixel.access_token || env.token || null,
      testEventCode: pixel.test_event_code ?? undefined,
      origen: 'pixel',
    }
  }
  if (env.dataset) {
    return { pixelId: env.dataset, token: env.token || null, origen: 'env' }
  }
  return null
}

export async function resolverCredencialesMeta(
  accountId: string,
  pixelId?: string | null,
): Promise<CredencialesMeta | null> {
  const db = supabaseAdmin()
  let query = db
    .from('tracking_pixels')
    .select('pixel_id, access_token, test_event_code')
    .eq('account_id', accountId)
    .eq('platform', 'meta')
    .eq('active', true)
  if (pixelId) query = query.eq('pixel_id', pixelId)
  const { data } = await query
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  let pixel: PixelMetaGuardado | null = null
  if (data?.pixel_id) {
    let token: string | null = null
    if (data.access_token) {
      try {
        token = decrypt(data.access_token as string)
      } catch (err) {
        console.error(
          '[tracking] token del píxel ilegible:',
          err instanceof Error ? err.message : err,
        )
      }
    }
    pixel = {
      pixel_id: data.pixel_id as string,
      access_token: token,
      test_event_code: (data.test_event_code as string | null) ?? null,
    }
  }

  return elegirCredenciales(pixel, {
    dataset: process.env.META_DATASET_ID,
    token: process.env.META_EVENTS_TOKEN,
  })
}

/** Credenciales CAPI atadas a una conexión/isla concreta. */
export interface CredencialesConexionMeta extends CredencialesMeta {
  connectionId: string
  wabaId: string
  /** Token de la WABA (para fallback de eventos si el píxel no trae uno). */
  wabaToken: string | null
}

/**
 * Resuelve el píxel de UNA conexión. Si la conexión no tiene
 * tracking_pixel_id o el píxel no es de la cuenta, devuelve null: es
 * preferible no enviar a mandar el evento al píxel de otra isla.
 */
export async function resolverCredencialesConexion(
  accountId: string,
  connectionId: string,
  pixelIdOverride?: string | null,
): Promise<CredencialesConexionMeta | null> {
  const db = supabaseAdmin()
  const { data: conn } = await db
    .from('whatsapp_connections')
    .select('id, account_id, waba_id, access_token, tracking_pixel_id, active')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .eq('active', true)
    .maybeSingle()
  if (!conn) return null

  const vinculado = (conn.tracking_pixel_id as string | null) ?? null
  if (!vinculado) return null

  const { data: pixel } = await db
    .from('tracking_pixels')
    .select('pixel_id, access_token, test_event_code')
    .eq('id', vinculado)
    .eq('account_id', accountId)
    .eq('platform', 'meta')
    .eq('active', true)
    .maybeSingle()
  if (!pixel?.pixel_id) return null

  // El nodo puede repetir el mismo píxel (por UUID o por pixel_id), pero
  // nunca elegir el de otra isla.
  if (
    pixelIdOverride &&
    pixelIdOverride !== vinculado &&
    pixelIdOverride !== pixel.pixel_id
  ) {
    return null
  }

  let pixelToken: string | null = null
  if (pixel.access_token) {
    try {
      pixelToken = decrypt(pixel.access_token as string)
    } catch {
      pixelToken = null
    }
  }

  let wabaToken: string | null = null
  if (conn.access_token) {
    try {
      wabaToken = decrypt(conn.access_token as string)
    } catch {
      wabaToken = null
    }
  }
  if (!conn.waba_id) return null

  return {
    pixelId: pixel.pixel_id as string,
    token: pixelToken || process.env.META_EVENTS_TOKEN || null,
    testEventCode: (pixel.test_event_code as string | null) ?? undefined,
    origen: 'pixel',
    connectionId: conn.id as string,
    wabaId: conn.waba_id as string,
    wabaToken,
  }
}

export async function monedaDeCuenta(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  const moneda = (data?.default_currency as string | null) ?? ''
  return /^[A-Z]{3}$/.test(moneda) ? moneda : 'MXN'
}
