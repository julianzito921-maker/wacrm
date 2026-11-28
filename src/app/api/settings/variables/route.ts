import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Configuración → Variables globales (`account_variables`). Los flujos
 * las leen como {{vars.nombre}}: el motor las carga al avanzar cada
 * corrida (sin pisar una variable del propio flujo con el mismo nombre).
 */

const CLAVE_VALIDA = /^[a-zA-Z0-9_]{1,60}$/;

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { data, error } = await supabase
      .from('account_variables')
      .select('key, value, description')
      .eq('account_id', accountId)
      .order('key', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({ variables: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!CLAVE_VALIDA.test(key)) return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
    const { error } = await supabase.from('account_variables').upsert(
      {
        account_id: accountId,
        key,
        value: typeof body.value === 'string' ? body.value.slice(0, 2000) : '',
        description: typeof body.description === 'string' ? body.description.slice(0, 200) || null : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,key' },
    );
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const key = new URL(request.url).searchParams.get('key') ?? '';
    if (!CLAVE_VALIDA.test(key)) return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
    const { error } = await supabase.from('account_variables').delete().eq('account_id', accountId).eq('key', key);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
