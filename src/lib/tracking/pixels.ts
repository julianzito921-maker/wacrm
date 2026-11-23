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
): Promise<CredencialesMeta | null> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('tracking_pixels')
    .select('pixel_id, access_token, test_event_code')
    .eq('account_id', accountId)
    .eq('platform', 'meta')
    .eq('active', true)
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

/** Moneda del evento: la del deal/llamada, si no la de la cuenta. */
export async function monedaDeCuenta(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  const moneda = (data?.default_currency as string | null) ?? ''
  return /^[A-Z]{3}$/.test(moneda) ? moneda : 'MXN'
}
