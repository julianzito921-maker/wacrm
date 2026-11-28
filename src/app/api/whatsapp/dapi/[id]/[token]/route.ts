import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { readCappedBody } from '@/lib/whatsapp/webhook-body';
import { aWebhookMeta, esDapi, numeroDeJid, sesionDe, type EventoDapi } from '@/lib/whatsapp/dapi';
import { POST as webhookMeta } from '../../../webhook/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function iguales(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Webhook de entrada de D-API. D-API no firma sus avisos: la URL lleva
 * un secreto por conexión y además se exige que el `sessionId` coincida.
 * Los mensajes y estados se traducen al formato de Meta, se firman con
 * el secreto propio de la isla y entran por el MISMO webhook de Meta, así
 * flujos, IA, inbox y ventas no distinguen el proveedor.
 *
 * Responde 404 a lo desconocido (D-API no reintenta 404/410).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; token: string }> },
) {
  const { id, token } = await context.params;
  const db = supabaseAdmin();
  const { data: conexion } = await db
    .from('whatsapp_connections')
    .select('id, phone_number_id, verify_token, app_secret, status')
    .eq('id', id)
    .maybeSingle();
  if (!conexion || !esDapi(conexion.phone_number_id as string) || !conexion.verify_token) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  let secretoUrl: string;
  let secretoFirma: string;
  try {
    secretoUrl = decrypt(conexion.verify_token as string);
    secretoFirma = decrypt(conexion.app_secret as string);
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!iguales(token, secretoUrl)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const raw = await readCappedBody(request);
  if (raw === null) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  let evento: EventoDapi;
  try {
    evento = JSON.parse(raw) as EventoDapi;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const phoneNumberId = conexion.phone_number_id as string;
  if (evento.sessionId !== sesionDe(phoneNumberId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (evento.event === 'connection.status') {
    const d = evento.data ?? {};
    const status = String(d.status ?? '');
    const patch: Record<string, unknown> = { last_synced_at: new Date().toISOString() };
    if (status === 'connected') {
      patch.status = 'connected';
      const numero = numeroDeJid((d.jid as string) ?? (d.phone as string));
      if (numero) {
        patch.phone_number = numero;
        patch.display_phone_number = `+${numero}`;
      }
    } else if (['disconnected', 'logged_out', 'qrcode_timeout'].includes(status)) {
      patch.status = 'disconnected';
      if (status === 'logged_out') {
        patch.health_reason = 'Se desvinculó el dispositivo en WhatsApp: vuelve a escanear el QR.';
      }
    }
    await db.from('whatsapp_connections').update(patch).eq('id', conexion.id);
    return NextResponse.json({ status: 'received' });
  }

  const cuerpo = aWebhookMeta(evento, phoneNumberId);
  if (!cuerpo) return NextResponse.json({ status: 'ignored' });

  const json = JSON.stringify(cuerpo);
  const firma =
    'sha256=' + crypto.createHmac('sha256', secretoFirma).update(json).digest('hex');
  return webhookMeta(
    new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma },
      body: json,
    }),
  );
}
