import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.waba_id === 'string') patch.waba_id = body.waba_id.trim() || null;
    if (typeof body.badge_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.badge_color)) {
      patch.badge_color = body.badge_color;
    }
    if (typeof body.access_token === 'string' && body.access_token.trim()) {
      patch.access_token = encrypt(body.access_token.trim());
    }
    if (typeof body.verify_token === 'string') {
      patch.verify_token = body.verify_token.trim()
        ? encrypt(body.verify_token.trim())
        : null;
    }
    if (typeof body.app_secret === 'string') {
      patch.app_secret = body.app_secret.trim()
        ? encrypt(body.app_secret.trim())
        : null;
    }
    if (typeof body.status === 'string' && ['connected', 'disconnected'].includes(body.status)) {
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CAMPOS_CONEXION_PUBLICOS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ connection: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
