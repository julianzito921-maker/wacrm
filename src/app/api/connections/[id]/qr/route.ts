import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { esDapi, obtenerQr, sesionDe } from '@/lib/whatsapp/dapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * QR de una conexión D-API. La pantalla lo pide cada pocos segundos
 * (D-API lo renueva solo) hasta que el estado sea `connected`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const db = supabaseAdmin();
    const { data: conexion } = await db
      .from('whatsapp_connections')
      .select('id, phone_number_id, access_token, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!conexion || !esDapi(conexion.phone_number_id as string)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    let estado;
    try {
      estado = await obtenerQr({
        apiKey: decrypt(conexion.access_token as string),
        sessionId: sesionDe(conexion.phone_number_id as string),
      });
    } catch (err) {
      return NextResponse.json(
        { error: 'dapi_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }

    const conectado = estado.status === 'connected';
    if (conectado && conexion.status !== 'connected') {
      await db
        .from('whatsapp_connections')
        .update({ status: 'connected', last_synced_at: new Date().toISOString() })
        .eq('id', id);
    }
    return NextResponse.json({
      status: estado.status,
      connected: conectado,
      qr_image: conectado ? null : estado.qrImage,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
