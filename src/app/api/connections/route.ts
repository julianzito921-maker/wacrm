import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';



export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('whatsapp_connections')
      .select(CAMPOS_CONEXION_PUBLICOS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({ connections: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const name = String(body.name ?? '').trim();
    const phoneNumberId = String(body.phone_number_id ?? '').trim();
    const wabaId = String(body.waba_id ?? '').trim() || null;
    const accessToken = String(body.access_token ?? '').trim();
    const verifyToken = String(body.verify_token ?? '').trim() || null;
    const appSecret = String(body.app_secret ?? '').trim() || null;
    const badgeColor =
      typeof body.badge_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.badge_color)
        ? body.badge_color
        : '#6366f1';

    if (!name || !phoneNumberId || !accessToken) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
    }

    let health;
    try {
      health = await getPhoneNumberHealth({ phoneNumberId, accessToken });
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
      .insert({
        account_id: ctx.accountId,
        name,
        phone_number: health.display_phone_number ?? null,
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: encrypt(accessToken),
        verify_token: verifyToken ? encrypt(verifyToken) : null,
        app_secret: appSecret ? encrypt(appSecret) : null,
        status: 'connected',
        quality_rating: health.quality_rating ?? null,
        messaging_limit_tier:
          health.whatsapp_business_manager_messaging_limit ?? null,
        badge_color: badgeColor,
        last_synced_at: new Date().toISOString(),
      })
      .select(CAMPOS_CONEXION_PUBLICOS)
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'duplicate_phone' }, { status: 409 });
      }
      throw new Error(error.message);
    }
    return NextResponse.json({ connection: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
