import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { parseQualityRating } from '@/lib/whatsapp/phone-health';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';
import { esDapi, esSesionOficial, obtenerConexionOficial, obtenerQr, sesionDe } from '@/lib/whatsapp/dapi';

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

    if (esSesionOficial(conexion.phone_number_id as string)) {
      try {
        const info = await obtenerConexionOficial(
          decrypt(conexion.access_token as string),
          sesionDe(conexion.phone_number_id as string),
        );
        const { data, error } = await supabaseAdmin()
          .from('whatsapp_connections')
          .update({
            status: 'connected',
            ...(info.wabaId ? { waba_id: info.wabaId } : {}),
            ...(info.telefono ? { phone_number: info.telefono, display_phone_number: `+${info.telefono}` } : {}),
            ...(info.calidad ? { quality_rating: info.calidad } : {}),
            last_synced_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', ctx.accountId)
          .select(CAMPOS_CONEXION_PUBLICOS)
          .single();
        if (error) throw new Error(error.message);
        return NextResponse.json({ connection: data });
      } catch (err) {
        return NextResponse.json(
          { error: 'meta_error', detail: err instanceof Error ? err.message : String(err) },
          { status: 502 },
        );
      }
    }

    if (esDapi(conexion.phone_number_id as string)) {
      let estado;
      try {
        estado = await obtenerQr({
          apiKey: decrypt(conexion.access_token as string),
          sessionId: sesionDe(conexion.phone_number_id as string),
        });
      } catch (err) {
        return NextResponse.json(
          { error: 'meta_error', detail: err instanceof Error ? err.message : String(err) },
          { status: 502 },
        );
      }
      const { data, error } = await supabaseAdmin()
        .from('whatsapp_connections')
        .update({
          status: estado.status === 'connected' ? 'connected' : 'disconnected',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .select(CAMPOS_CONEXION_PUBLICOS)
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ connection: data });
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

    const quality = parseQualityRating(health.quality_rating);
    const limit = health.whatsapp_business_manager_messaging_limit ?? null;
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update({
        phone_number: health.display_phone_number ?? null,
        display_phone_number: health.display_phone_number ?? null,
        quality_rating: health.quality_rating ?? null,
        whatsapp_business_manager_messaging_limit: limit,
        messaging_limit_tier: limit,
        messaging_limit_updated_at: new Date().toISOString(),
        health_status:
          quality === 'RED'
            ? 'restricted'
            : quality === 'YELLOW'
              ? 'warning'
              : 'healthy',
        restriction_scope: quality === 'RED' ? 'mass' : null,
        health_reason:
          quality === 'RED'
            ? 'Calidad del número en RED (sync de Meta).'
            : null,
        last_health_event_at: new Date().toISOString(),
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
