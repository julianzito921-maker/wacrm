import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';
import {
  actualizarWebhookSesion,
  configurarWebhookOficial,
  DapiError,
  obtenerConexionOficial,
  obtenerQr,
  phoneNumberIdDeSesion,
} from '@/lib/whatsapp/dapi';
import { urlBaseWebhook } from '@/lib/flows/pagos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Conectar una instancia de D-API como en su tutorial: se copian de D-API
 * (Instâncias → ⋮ → Configurações → Desenvolvedor) el **Instance ID** y la
 * **API Key** de esa instancia, se pegan aquí y listo.
 *
 * Sirve para números oficiales («cloud-…») y de QR. Se valida la clave
 * contra D-API, se crea la isla y se apunta el webhook de la instancia a la
 * URL secreta del WaCRM. La clave queda guardada (cifrada) en la propia
 * conexión, así cada instancia usa la suya.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const nombre = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!/^[\w-]{2,80}$/.test(instanceId)) {
      return NextResponse.json({ error: 'invalid_instance' }, { status: 400 });
    }
    if (apiKey.length < 10 || apiKey.startsWith('pk_live_')) {
      return NextResponse.json({ error: 'invalid_api_key' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const pnid = phoneNumberIdDeSesion(instanceId);
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

    // Validar la clave y leer el número antes de crear nada.
    const oficial = instanceId.startsWith('cloud-');
    let info: { wabaId: string | null; telefono: string; nombre: string; calidad: string | null; conectado: boolean };
    try {
      if (oficial) {
        const c = await obtenerConexionOficial(apiKey, instanceId);
        info = { ...c, conectado: true };
      } else {
        const q = await obtenerQr({ apiKey, sessionId: instanceId });
        info = { wabaId: null, telefono: '', nombre: '', calidad: null, conectado: q.status === 'connected' };
      }
    } catch (err) {
      const status = err instanceof DapiError ? err.httpStatus : 0;
      return NextResponse.json(
        {
          error: status === 401 || status === 403 ? 'invalid_api_key' : status === 404 ? 'instance_not_found' : 'dapi_error',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 400 },
      );
    }

    const { count } = await db
      .from('whatsapp_connections')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);
    const token = randomBytes(24).toString('hex');
    const { data: fila, error } = await db
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        name: nombre || info.nombre || (info.telefono ? `+${info.telefono}` : instanceId),
        provider: 'dapi',
        phone_number_id: pnid,
        waba_id: info.wabaId,
        phone_number: info.telefono || null,
        display_phone_number: info.telefono ? `+${info.telefono}` : null,
        quality_rating: info.calidad,
        access_token: encrypt(apiKey),
        verify_token: encrypt(token),
        app_secret: encrypt(randomBytes(32).toString('hex')),
        status: info.conectado ? 'connected' : 'disconnected',
        badge_color: oficial ? '#22c55e' : '#14b8a6',
        is_default: (count ?? 0) === 0,
        active: true,
        last_synced_at: new Date().toISOString(),
      })
      .select(CAMPOS_CONEXION_PUBLICOS)
      .single();
    if (error) throw new Error(error.message);
    const conexion = fila as unknown as { id: string };

    const url = `${urlBaseWebhook(request)}/api/whatsapp/dapi/${conexion.id}/${token}`;
    try {
      if (oficial) await configurarWebhookOficial(apiKey, instanceId, url);
      else await actualizarWebhookSesion(apiKey, instanceId, url);
    } catch (err) {
      await db.from('whatsapp_connections').delete().eq('id', conexion.id);
      return NextResponse.json(
        { error: 'dapi_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
    return NextResponse.json({ connection: conexion }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
