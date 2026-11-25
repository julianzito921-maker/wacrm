// ============================================================
// POST /api/account/webhooks/[id]/rotate-secret — secreto nuevo.
//
// Para cuando el secreto se perdió o se filtró. El anterior deja de
// valer al instante (las entregas siguientes ya firman con el nuevo),
// así que el receptor debe actualizarse enseguida. El nuevo se
// devuelve en texto plano UNA sola vez. Admin+.
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
import { encrypt } from '@/lib/whatsapp/encryption';
import { generateWebhookSecret } from '@/lib/webhooks/endpoints';

const t = getT('Api');

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:webhookRotate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: t('account.webhooks.notFound') },
        { status: 404 }
      );
    }

    const secret = generateWebhookSecret();
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update({ secret: encrypt(secret) })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[POST /api/account/webhooks/[id]/rotate-secret] error:', error);
      return NextResponse.json(
        { error: t('account.webhooks.rotateFailed') },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: t('account.webhooks.notFound') },
        { status: 404 }
      );
    }
    return NextResponse.json({ secret });
  } catch (err) {
    return toErrorResponse(err);
  }
}
