// ============================================================
// PATCH  /api/account/webhooks/[id] — cambia url, eventos o encendido.
// DELETE /api/account/webhooks/[id] — borra el webhook.
//
// Admin+ (requireRole + RLS). Filtra también por account_id: un id de
// otra cuenta da 404 y no toca nada.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { isUuid } from '@/lib/api/v1/pagination';
import { normalizeEvents } from '@/lib/webhooks/events';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  checkWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

const t = getT('Api');

type Params = { params: Promise<{ id: string }> };

function error(key: string, status: number) {
  return NextResponse.json({ error: t(`account.webhooks.${key}`) }, { status });
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:webhookUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return error('notFound', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') return error('nothingToUpdate', 400);

    const updates: Record<string, unknown> = {};
    let urlNueva: string | null = null;
    if ('url' in body) {
      const urlCheck = checkWebhookUrl(body.url);
      if (!urlCheck.ok) return error('urlInvalid', 400);
      const { data: actual, error: readErr } = await ctx.supabase
        .from('webhook_endpoints')
        .select('url')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (readErr) {
        console.error('[PATCH /api/account/webhooks/[id]] read error:', readErr);
        return error('updateFailed', 500);
      }
      if (!actual) return error('notFound', 404);
      // Misma URL: no es un cambio (no se revalida ni se borra la racha
      // de fallos, que marca «Apagado por fallos»).
      if (actual.url !== urlCheck.url) urlNueva = urlCheck.url;
    }
    if (urlNueva) {
      if (!(await isDeliverableUrl(urlNueva))) {
        return error('urlNotPublic', 400);
      }
      updates.url = urlNueva;
      // Destino nuevo: los fallos del anterior ya no cuentan.
      updates.failure_count = 0;
    }
    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) return error('eventsInvalid', 400);
      updates.events = events;
    }
    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return error('nothingToUpdate', 400);
      }
      updates.is_active = body.is_active;
      // Al reencender se limpia la racha de fallos (igual que la API v1).
      if (body.is_active === true) updates.failure_count = 0;
    }
    if (Object.keys(updates).length === 0) return error('nothingToUpdate', 400);

    const { data, error: dbError } = await ctx.supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();

    if (dbError) {
      console.error('[PATCH /api/account/webhooks/[id]] error:', dbError);
      return error('updateFailed', 500);
    }
    if (!data) return error('notFound', 404);
    return NextResponse.json({
      webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:webhookDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return error('notFound', 404);

    const { data, error: dbError } = await ctx.supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (dbError) {
      console.error('[DELETE /api/account/webhooks/[id]] error:', dbError);
      return error('deleteFailed', 500);
    }
    if (!data) return error('notFound', 404);
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
