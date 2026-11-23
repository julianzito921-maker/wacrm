import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from './encryption';

export const CAMPOS_CONEXION_PUBLICOS =
  'id, name, phone_number, phone_number_id, waba_id, status, quality_rating, messaging_limit_tier, badge_color, last_synced_at, created_at';

export interface ConnectionCredentials {
  connectionId: string | null;
  phoneNumberId: string;
  accessToken: string;
}

type Db = SupabaseClient;

async function credencialesDeFila(
  db: Db,
  fila: { id?: string; phone_number_id: string; access_token: string } | null,
): Promise<ConnectionCredentials | null> {
  if (!fila?.phone_number_id || !fila.access_token) return null;
  try {
    return {
      connectionId: fila.id ?? null,
      phoneNumberId: fila.phone_number_id,
      accessToken: decrypt(fila.access_token),
    };
  } catch (err) {
    console.error(
      '[whatsapp] token de conexión ilegible:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function credencialesDeConexion(
  db: Db,
  connectionId: string,
): Promise<ConnectionCredentials | null> {
  try {
    const { data } = await db
      .from('whatsapp_connections')
      .select('id, phone_number_id, access_token')
      .eq('id', connectionId)
      .maybeSingle();
    return credencialesDeFila(db, data as never);
  } catch {
    return null;
  }
}

export async function credencialesPrimarias(
  db: Db,
  accountId: string,
): Promise<ConnectionCredentials | null> {
  try {
    const { data } = await db
      .from('whatsapp_connections')
      .select('id, phone_number_id, access_token')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const deConexion = await credencialesDeFila(db, data as never);
    if (deConexion) return deConexion;
  } catch {
    // Tabla aún no disponible (tests/rollout): se usa el respaldo.
  }

  try {
    const { data: legacy } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single();
    return credencialesDeFila(db, legacy as never);
  } catch {
    return null;
  }
}

export async function credencialesDeConversacion(
  db: Db,
  conversationId: string | null | undefined,
  fallbackAccountId?: string | null,
): Promise<ConnectionCredentials | null> {
  if (conversationId) {
    try {
      const { data } = await db
        .from('conversations')
        .select('connection_id, account_id')
        .eq('id', conversationId)
        .maybeSingle();
      if (data?.connection_id) {
        const creds = await credencialesDeConexion(
          db,
          data.connection_id as string,
        );
        if (creds) return creds;
      }
      if (data?.account_id) {
        const creds = await credencialesPrimarias(db, data.account_id as string);
        if (creds) return creds;
      }
    } catch {
      // Sin tabla de conversaciones: cae al respaldo de cuenta.
    }
  }
  if (fallbackAccountId) return credencialesPrimarias(db, fallbackAccountId);
  return null;
}
