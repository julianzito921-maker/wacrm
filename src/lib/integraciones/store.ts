import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';

/**
 * Configuración → Integraciones (como en Leona). Una clave secreta por
 * cuenta y proveedor en `account_integrations`, cifrada con la misma
 * llave que los tokens de WhatsApp.
 */
export const PROVEEDORES_INTEGRACION = ['dapi', 'openrouter', 'lowtrack', 'leona'] as const;
export type ProveedorIntegracion = (typeof PROVEEDORES_INTEGRACION)[number];

export function esProveedorIntegracion(v: unknown): v is ProveedorIntegracion {
  return typeof v === 'string' && (PROVEEDORES_INTEGRACION as readonly string[]).includes(v);
}

/** Validación mínima por proveedor; devuelve el código de error o null. */
export function errorDeClave(provider: ProveedorIntegracion, clave: string): string | null {
  const k = clave.trim();
  if (k.length < 8) return 'invalid_api_key';
  if (provider === 'dapi' && k.startsWith('pk_live_')) return 'dapi_public_key';
  return null;
}

/** Clave en claro de la integración, o null si no existe / no se lee. */
export async function leerClaveIntegracion(
  accountId: string,
  provider: ProveedorIntegracion,
  db: SupabaseClient = supabaseAdmin(),
): Promise<string | null> {
  try {
    const { data } = await db
      .from('account_integrations')
      .select('secret')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .maybeSingle();
    if (!data?.secret) return null;
    return decrypt(data.secret as string);
  } catch {
    return null;
  }
}

export { OPENROUTER_BASE_URL } from './constantes';

export function esUrlOpenRouter(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}
