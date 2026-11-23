import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { parseQualityRating } from '@/lib/whatsapp/phone-health';
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
    const trackingPixelId = String(body.tracking_pixel_id ?? '').trim() || null;
    const customDomainRaw = String(body.custom_domain ?? '').trim().toLowerCase();
    const customDomain = customDomainRaw
      ? customDomainRaw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
      : null;
    if (customDomain && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(customDomain)) {
      return NextResponse.json({ error: 'invalid_domain' }, { status: 400 });
    }
    const requestedDefault = body.is_default === true;
    const active = body.active !== false;

    if (!name || !phoneNumberId || !accessToken) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
    }

    if (trackingPixelId) {
      const { data: pixel } = await ctx.supabase
        .from('tracking_pixels')
        .select('id')
        .eq('id', trackingPixelId)
        .eq('account_id', ctx.accountId)
        .eq('platform', 'meta')
        .maybeSingle();
      if (!pixel) {
        return NextResponse.json({ error: 'invalid_pixel' }, { status: 400 });
      }
    }

    const { count: existentes } = await ctx.supabase
      .from('whatsapp_connections')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);
    const isDefault = requestedDefault || (existentes ?? 0) === 0;

    if (isDefault) {
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ is_default: false })
        .eq('account_id', ctx.accountId)
        .eq('is_default', true);
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

    const quality = parseQualityRating(health.quality_rating);
    const limit = health.whatsapp_business_manager_messaging_limit ?? null;
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        name,
        phone_number: health.display_phone_number ?? null,
        display_phone_number: health.display_phone_number ?? null,
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: encrypt(accessToken),
        verify_token: verifyToken ? encrypt(verifyToken) : null,
        app_secret: appSecret ? encrypt(appSecret) : null,
        status: 'connected',
        quality_rating: health.quality_rating ?? null,
        whatsapp_business_manager_messaging_limit: limit,
        messaging_limit_tier: limit,
        messaging_limit_updated_at: new Date().toISOString(),
        health_status: quality === 'RED' ? 'restricted' : quality === 'YELLOW' ? 'warning' : 'healthy',
        restriction_scope: quality === 'RED' ? 'mass' : null,
        last_health_event_at: new Date().toISOString(),
        badge_color: badgeColor,
        tracking_pixel_id: trackingPixelId,
        custom_domain: customDomain,
        is_default: isDefault,
        active,
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
