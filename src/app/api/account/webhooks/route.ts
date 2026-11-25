// ============================================================
// /api/account/webhooks — pantalla «Webhooks» del panel.
//
//   GET  — lista los webhooks salientes de la cuenta (sin secretos).
//   POST — registra uno nuevo y devuelve su secreto de firma UNA vez.
//
// Es la contraparte con sesión (cookie) de /api/v1/webhooks, que usa
// clave de API. Ver es para cualquier miembro (RLS lo permite); crear
// es admin+ (`requireRole('admin')` + política RLS de insert). El
// secreto se guarda cifrado (AES-256-GCM) y solo se devuelve aquí.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  MAX_WEBHOOKS_PER_ACCOUNT,
  WEBHOOK_PUBLIC_COLUMNS,
  checkWebhookUrl,
  generateWebhookSecret,
  serializeWebhookEndpoint,
  webhookLimitReached,
} from '@/lib/webhooks/endpoints';

const t = getT('Api');

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/webhooks] error:', error);
      return NextResponse.json(
        { error: t('account.webhooks.loadFailed') },
        { status: 500 }
      );
    }
    return NextResponse.json({
      webhooks: (data ?? []).map((r) =>
        serializeWebhookEndpoint(r as Record<string, unknown>)
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      events?: unknown;
    } | null;

    const urlCheck = checkWebhookUrl(body?.url);
    if (!urlCheck.ok) {
      return NextResponse.json(
        { error: t('account.webhooks.urlInvalid') },
        { status: 400 }
      );
    }
    // Se rechaza ya una dirección interna/privada: si no, se guardaría
    // y fallaría en silencio hasta auto-desactivarse.
    if (!(await isDeliverableUrl(urlCheck.url))) {
      return NextResponse.json(
        { error: t('account.webhooks.urlNotPublic') },
        { status: 400 }
      );
    }
    const events = normalizeEvents(body?.events);
    if (!events) {
      return NextResponse.json(
        { error: t('account.webhooks.eventsInvalid') },
        { status: 400 }
      );
    }

    const lleno = await webhookLimitReached(ctx.supabase, ctx.accountId);
    if (lleno === null) {
      return NextResponse.json(
        { error: t('account.webhooks.createFailed') },
        { status: 500 }
      );
    }
    if (lleno) {
      return NextResponse.json(
        {
          error: t('account.webhooks.limitReached', {
            max: MAX_WEBHOOKS_PER_ACCOUNT,
          }),
        },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        url: urlCheck.url,
        events,
        secret: encrypt(secret),
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/account/webhooks] insert error:', error);
      return NextResponse.json(
        { error: t('account.webhooks.createFailed') },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
        // Texto plano: se muestra al admin una sola vez.
        secret,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
