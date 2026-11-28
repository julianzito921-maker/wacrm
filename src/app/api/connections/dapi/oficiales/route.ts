import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';
import { leerClaveIntegracion } from '@/lib/integraciones/store';
import {
  configurarWebhookOficial,
  DapiError,
  listarSesiones,
  obtenerConexionOficial,
  phoneNumberIdDeSesion,
} from '@/lib/whatsapp/dapi';
import { urlBaseWebhook } from '@/lib/flows/pagos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * API oficial con D-API como proveedor.
 *
 * GET: los números oficiales (sesiones «cloud-…») de la cuenta de D-API,
 *      marcando cuáles ya están conectados al WaCRM.
 * POST { sessionId }: conecta uno: crea la isla (WABA, número y nombre de
 *      D-API) y apunta el webhook de ese número a la URL secreta del
 *      WaCRM. Desde ahí entra todo por el mismo camino que Meta: contactos,
 *      inbox, flujos, IA y ventas.
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const apiKey = await leerClaveIntegracion(ctx.accountId, 'dapi');
    if (!apiKey) return NextResponse.json({ error: 'dapi_not_configured' }, { status: 400 });
    const sesiones = await listarSesiones(apiKey, 'cloud_api');
    const { data } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('id, phone_number_id')
      .eq('account_id', ctx.accountId)
      .like('phone_number_id', 'dapi:%');
    const enlazadas = new Map(
      ((data ?? []) as Array<{ id: string; phone_number_id: string }>).map((c) => [c.phone_number_id, c.id]),
    );
    return NextResponse.json({
      sessions: sesiones.map((s) => ({
        ...s,
        connection_id: enlazadas.get(phoneNumberIdDeSesion(s.sessionId)) ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof DapiError) {
      return NextResponse.json({ error: 'dapi_error', detail: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!/^cloud-[\w-]{4,}$/.test(sessionId)) {
      return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
    }
    const apiKey = await leerClaveIntegracion(ctx.accountId, 'dapi');
    if (!apiKey) return NextResponse.json({ error: 'dapi_not_configured' }, { status: 400 });

    const db = supabaseAdmin();
    const pnid = phoneNumberIdDeSesion(sessionId);
    const { data: existente } = await db
      .from('whatsapp_connections')
      .select('id, account_id')
      .eq('phone_number_id', pnid)
      .maybeSingle();
    if (existente) {
      return NextResponse.json(
        { error: existente.account_id === ctx.accountId ? 'already_connected' : 'duplicate_phone' },
        { status: 409 },
      );
    }

    const info = await obtenerConexionOficial(apiKey, sessionId);
    const { count } = await db
      .from('whatsapp_connections')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);

    const token = randomBytes(24).toString('hex');
    const { data: fila, error } = await db
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        name: info.nombre || (info.telefono ? `+${info.telefono}` : 'WhatsApp oficial'),
        provider: 'dapi',
        phone_number_id: pnid,
        waba_id: info.wabaId,
        phone_number: info.telefono || null,
        display_phone_number: info.telefono ? `+${info.telefono}` : null,
        quality_rating: info.calidad,
        access_token: encrypt(apiKey),
        verify_token: encrypt(token),
        app_secret: encrypt(randomBytes(32).toString('hex')),
        status: 'connected',
        badge_color: '#22c55e',
        is_default: (count ?? 0) === 0,
        active: true,
        last_synced_at: new Date().toISOString(),
      })
      .select(CAMPOS_CONEXION_PUBLICOS)
      .single();
    if (error) throw new Error(error.message);
    const conexion = fila as unknown as { id: string };

    try {
      await configurarWebhookOficial(
        apiKey,
        sessionId,
        `${urlBaseWebhook(request)}/api/whatsapp/dapi/${conexion.id}/${token}`,
      );
    } catch (err) {
      await db.from('whatsapp_connections').delete().eq('id', conexion.id);
      return NextResponse.json(
        { error: 'dapi_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
    return NextResponse.json({ connection: conexion }, { status: 201 });
  } catch (err) {
    if (err instanceof DapiError) {
      return NextResponse.json({ error: 'dapi_error', detail: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
