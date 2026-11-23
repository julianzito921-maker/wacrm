import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * POST /api/dashboard/ad-spend/sync
 *
 * Sincroniza el gasto diario de Meta Insights cuando existen
 * META_AD_ACCOUNT_ID y META_ADS_TOKEN (con permiso ads_read). Sin esas
 * variables responde not_configured; la edición manual sigue disponible.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const from = typeof body.from === 'string' ? body.from.slice(0, 10) : '';
    const to = typeof body.to === 'string' ? body.to.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: 'invalid_range' }, { status: 400 });
    }

    const adAccount = process.env.META_AD_ACCOUNT_ID?.trim().replace(/^act_/, '');
    const token = process.env.META_ADS_TOKEN?.trim();
    if (!adAccount || !token) {
      return NextResponse.json({ error: 'not_configured' }, { status: 400 });
    }

    const { data: cuenta } = await ctx.supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', ctx.accountId)
      .maybeSingle();
    const currency = (cuenta?.default_currency as string | undefined) ?? 'USD';

    const params = new URLSearchParams({
      level: 'account',
      time_increment: '1',
      fields: 'spend',
      time_range: JSON.stringify({ since: from, until: to }),
      access_token: token,
    });
    const res = await fetch(
      `https://graph.facebook.com/v21.0/act_${adAccount}/insights?${params.toString()}`,
      { signal: AbortSignal.timeout(25_000) },
    );
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ date_start?: string; spend?: string }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      return NextResponse.json(
        { error: 'meta_error', detail: json.error?.message ?? `HTTP ${res.status}` },
        { status: 502 },
      );
    }

    const filas = (json.data ?? [])
      .filter((d) => d.date_start && d.spend !== undefined)
      .map((d) => ({
        account_id: ctx.accountId,
        platform: 'meta',
        spent_on: d.date_start as string,
        amount: Number(d.spend) || 0,
        currency,
        created_by: ctx.userId,
      }));
    if (filas.length === 0) {
      return NextResponse.json({ synced: 0, message: 'no_data' });
    }
    const { error } = await ctx.supabase
      .from('ad_spend')
      .upsert(filas, { onConflict: 'account_id,platform,spent_on' });
    if (error) throw new Error(error.message);
    return NextResponse.json({ synced: filas.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
