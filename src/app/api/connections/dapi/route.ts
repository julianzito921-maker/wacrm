import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';
import { crearSesion, DapiError, phoneNumberIdDeSesion } from '@/lib/whatsapp/dapi';
import { urlBaseWebhook } from '@/lib/flows/pagos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Nueva conexión por QR (D-API). Crea la isla, abre la sesión en D-API
 * con su webhook secreto y devuelve la conexión; el QR se pide aparte en
 * `/api/connections/[id]/qr`.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
    const badgeColor =
      typeof body.badge_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.badge_color)
        ? body.badge_color
        : '#22c55e';

    const db = supabaseAdmin();
    const { data: cfg } = await db
      .from('account_integrations')
      .select('secret')
      .eq('account_id', ctx.accountId)
      .eq('provider', 'dapi')
      .maybeSingle();
    if (!cfg?.secret) {
      return NextResponse.json({ error: 'dapi_not_configured' }, { status: 400 });
    }
    let apiKey: string;
    try {
      apiKey = decrypt(cfg.secret as string);
    } catch {
      return NextResponse.json({ error: 'dapi_key_unreadable' }, { status: 400 });
    }

    const { count } = await db
      .from('whatsapp_connections')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);

    const sessionId = `wacrm-${randomBytes(6).toString('hex')}`;
    const token = randomBytes(24).toString('hex');
    const { data: fila, error } = await db
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        name,
        provider: 'dapi',
        phone_number_id: phoneNumberIdDeSesion(sessionId),
        access_token: cfg.secret,
        verify_token: encrypt(token),
        app_secret: encrypt(randomBytes(32).toString('hex')),
        status: 'disconnected',
        badge_color: badgeColor,
        is_default: (count ?? 0) === 0,
        active: true,
      })
      .select(CAMPOS_CONEXION_PUBLICOS)
      .single();
    if (error) throw new Error(error.message);
    const conexion = fila as unknown as { id: string };

    try {
      await crearSesion({
        apiKey,
        sessionId,
        webhookUrl: `${urlBaseWebhook(request)}/api/whatsapp/dapi/${conexion.id}/${token}`,
      });
    } catch (err) {
      await db.from('whatsapp_connections').delete().eq('id', conexion.id);
      return NextResponse.json(
        {
          error: 'dapi_error',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: err instanceof DapiError && err.httpStatus === 401 ? 400 : 502 },
      );
    }

    return NextResponse.json({ connection: conexion }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
