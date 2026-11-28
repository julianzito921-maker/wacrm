import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { iniciarFlujoAtencionFinalizada } from '@/lib/flows/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * El inbox avisa aquí al marcar una conversación como completada: si su
 * número tiene flujo estándar «Atención finalizada», arranca (Leona).
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('agent');
    const { data: conv } = await supabaseAdmin()
      .from('conversations')
      .select('id, contact_id, connection_id, status, account_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (conv.status !== 'closed') return NextResponse.json({ iniciado: false, motivo: 'no_cerrada' });
    const { data: cuenta } = await supabaseAdmin()
      .from('accounts')
      .select('owner_user_id')
      .eq('id', ctx.accountId)
      .maybeSingle();
    const r = await iniciarFlujoAtencionFinalizada({
      accountId: ctx.accountId,
      userId: (cuenta as { owner_user_id?: string } | null)?.owner_user_id ?? ctx.userId,
      contactId: conv.contact_id as string,
      conversationId: conv.id as string,
      connectionId: (conv.connection_id as string | null) ?? null,
    });
    return NextResponse.json(r);
  } catch (err) {
    return toErrorResponse(err);
  }
}
