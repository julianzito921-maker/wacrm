import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Configuración → Productos: el catálogo de la cuenta (`product_catalog`). */

const CAMPOS = 'id, nombre, precio, moneda, notas, activo';

function clave(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${base || 'producto'}_${Math.random().toString(36).slice(2, 6)}`;
}

function limpiar(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (typeof body.nombre === 'string' && body.nombre.trim()) patch.nombre = body.nombre.trim().slice(0, 120);
  if (body.precio === null || typeof body.precio === 'number') {
    patch.precio = body.precio === null || !Number.isFinite(body.precio) ? null : Math.max(0, body.precio as number);
  }
  if (body.moneda === 'MXN' || body.moneda === 'USD') patch.moneda = body.moneda;
  if (typeof body.notas === 'string') patch.notas = body.notas.trim().slice(0, 500) || null;
  if (typeof body.activo === 'boolean') patch.activo = body.activo;
  return patch;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { data, error } = await supabase
      .from('product_catalog')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({ products: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const patch = limpiar((await request.json().catch(() => ({}))) as Record<string, unknown>);
    if (!patch.nombre) return NextResponse.json({ error: 'missing_name' }, { status: 400 });
    const { data, error } = await supabase
      .from('product_catalog')
      .insert({ ...patch, account_id: accountId, clave: clave(patch.nombre as string) })
      .select(CAMPOS)
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ product: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.id !== 'string') return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    const { data, error } = await supabase
      .from('product_catalog')
      .update({ ...limpiar(body), updated_at: new Date().toISOString() })
      .eq('id', body.id)
      .eq('account_id', accountId)
      .select(CAMPOS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ product: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    const { error } = await supabase.from('product_catalog').delete().eq('id', id).eq('account_id', accountId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
