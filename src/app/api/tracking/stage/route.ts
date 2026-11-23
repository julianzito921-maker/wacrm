import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { enviarEventoMeta } from '@/lib/ventas/conversiones'

/**
 * POST /api/tracking/stage
 *
 * Hook del Kanban: cuando un deal cambia de etapa, si el píxel Meta de
 * la cuenta tiene configurada esa etapa como «compra», dispara Purchase
 * con el valor del deal. Lo llama pipelines/page.tsx sin esperar la
 * respuesta; nunca frena el movimiento.
 *
 * Body: { deal_id: string }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const dealId = String(body.deal_id ?? '').trim()
    if (!dealId) {
      return NextResponse.json({ error: 'missing_deal' }, { status: 400 })
    }

    const { data: deal } = await supabase
      .from('deals')
      .select('id, contact_id, value, currency, stage_id')
      .eq('id', dealId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!deal?.contact_id) {
      return NextResponse.json({ error: 'deal_not_found' }, { status: 404 })
    }

    const { data: pixel } = await supabase
      .from('tracking_pixels')
      .select('id')
      .eq('account_id', accountId)
      .eq('platform', 'meta')
      .eq('active', true)
      .eq('purchase_stage_id', deal.stage_id)
      .limit(1)
      .maybeSingle()
    if (!pixel) {
      return NextResponse.json({ enviado: false, motivo: 'sin_etapa' })
    }

    const valor = Number(deal.value)
    const resultado = await enviarEventoMeta({
      accountId,
      contactId: deal.contact_id as string,
      eventName: 'Purchase',
      eventId: `deal-${deal.id}-${deal.stage_id}-${Date.now()}`,
      value: Number.isFinite(valor) && valor > 0 ? valor : undefined,
      currency:
        typeof deal.currency === 'string' && /^[A-Z]{3}$/.test(deal.currency)
          ? deal.currency
          : undefined,
    })
    return NextResponse.json(resultado, { status: resultado.enviado ? 200 : 202 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
