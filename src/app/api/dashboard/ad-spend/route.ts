import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * GET    /api/dashboard/ad-spend?from=…&to=…   → gasto diario del periodo
 * PUT    /api/dashboard/ad-spend               → alta/edición manual
 * DELETE /api/dashboard/ad-spend?id=…          → borrar una entrada
 */

function fechaISO(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let query = ctx.supabase
      .from('ad_spend')
      .select('id, spent_on, amount, currency, notes')
      .eq('account_id', ctx.accountId)
      .eq('platform', 'meta')
      .order('spent_on', { ascending: false })
      .limit(120);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) query = query.gte('spent_on', from);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) query = query.lte('spent_on', to);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ entries: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const spentOn = fechaISO(body.spent_on);
    const amount = Number(body.amount);
    if (!spentOn) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
    }
    const { data: cuenta } = await ctx.supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', ctx.accountId)
      .maybeSingle();
    const currency =
      typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)
        ? body.currency
        : ((cuenta?.default_currency as string | undefined) ?? 'USD');

    const { data, error } = await ctx.supabase
      .from('ad_spend')
      .upsert(
        {
          account_id: ctx.accountId,
          platform: 'meta',
          spent_on: spentOn,
          amount,
          currency,
          notes:
            typeof body.notes === 'string' && body.notes.trim()
              ? body.notes.trim()
              : null,
          created_by: ctx.userId,
        },
        { onConflict: 'account_id,platform,spent_on' },
      )
      .select('id, spent_on, amount, currency, notes')
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ entry: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from('ad_spend')
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
