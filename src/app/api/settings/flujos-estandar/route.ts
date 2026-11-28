import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { normalizarFlujosEstandar } from '@/lib/flows/estandar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Configuración → Flujos estándar (como Leona).
 * GET: conexiones con sus flujos estándar.
 * PUT { connection_ids: [...], standard_flows: {...} }: guarda la misma
 *      configuración en una o varias conexiones («Selección masiva»).
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('id, name, phone_number, display_phone_number, status, standard_flows')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({
      connections: (data ?? []).map((c) => ({
        ...c,
        standard_flows: normalizarFlujosEstandar((c as { standard_flows?: unknown }).standard_flows),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as {
      connection_ids?: unknown;
      standard_flows?: unknown;
    };
    const ids = (Array.isArray(body.connection_ids) ? body.connection_ids : []).filter(
      (x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x),
    );
    if (ids.length === 0) return NextResponse.json({ error: 'no_connections' }, { status: 400 });
    const cfg = normalizarFlujosEstandar(body.standard_flows);

    // Solo flujos de esta cuenta.
    const usados = [
      cfg.welcome_flow_id,
      cfg.reopened_flow_id,
      cfg.default_reply_flow_id,
      cfg.attendance_finished_flow_id,
      ...(cfg.keywords ?? []).map((k) => k.flow_id),
    ].filter((x): x is string => Boolean(x));
    if (usados.length) {
      const { data: propios } = await supabaseAdmin()
        .from('flows')
        .select('id')
        .eq('account_id', ctx.accountId)
        .in('id', [...new Set(usados)]);
      if ((propios ?? []).length !== new Set(usados).size) {
        return NextResponse.json({ error: 'invalid_flow' }, { status: 400 });
      }
    }

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update({ standard_flows: cfg })
      .eq('account_id', ctx.accountId)
      .in('id', ids)
      .select('id');
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, updated: (data ?? []).length, standard_flows: cfg });
  } catch (err) {
    return toErrorResponse(err);
  }
}
