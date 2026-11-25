// ============================================================
// POST /api/account/webhooks/[id]/test — botón «Enviar prueba».
//
// Manda un evento `webhook.test` firmado solo a ese webhook y devuelve
// el código HTTP y el tiempo (nunca el cuerpo de la respuesta). No
// cuenta como fallo ni como entrega real. Admin+, con límite propio
// más estricto: dispara una petición saliente del servidor.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { isUuid } from '@/lib/api/v1/pagination';
import { sendTestDelivery } from '@/lib/webhooks/deliver';

const t = getT('Api');

/** 5 pruebas por minuto por cuenta. */
const TEST_LIMIT = { limit: 5, windowMs: 60_000 };

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`webhookTest:${ctx.accountId}`, TEST_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: t('account.webhooks.notFound') },
        { status: 404 }
      );
    }

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[POST /api/account/webhooks/[id]/test] error:', error);
      return NextResponse.json(
        { error: t('account.webhooks.testFailed') },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: t('account.webhooks.notFound') },
        { status: 404 }
      );
    }

    const result = await sendTestDelivery(
      data as { id: string; url: string; secret: string },
      ctx.accountId
    );
    return NextResponse.json({ result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
