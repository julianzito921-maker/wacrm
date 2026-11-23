import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const { data: conexion } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('id, phone_number_id, access_token')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!conexion?.access_token) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    let health;
    try {
      health = await getPhoneNumberHealth({
        phoneNumberId: conexion.phone_number_id as string,
        accessToken: decrypt(conexion.access_token as string),
      });
    } catch (err) {
      return NextResponse.json(
        {
          error: 'meta_error',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 502 },
      );
    }

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update({
        phone_number: health.display_phone_number ?? null,
        quality_rating: health.quality_rating ?? null,
        messaging_limit_tier:
          health.whatsapp_business_manager_messaging_limit ?? null,
        status: 'connected',
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CAMPOS_CONEXION_PUBLICOS)
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ connection: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
