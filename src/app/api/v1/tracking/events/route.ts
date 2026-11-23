import { requireApiKey } from '@/lib/auth/api-context'
import { badRequest, ok, toApiErrorResponse } from '@/lib/api/v1/respond'
import { META_CAPI_EVENTOS, type MetaCapiEventName } from '@/lib/flows/types'
import { enviarEventoMeta } from '@/lib/ventas/conversiones'
import { normalizarTelefono } from '@/lib/tracking/links'

/**
 * POST /api/v1/tracking/events
 *
 * Dispara un evento de conversión (Meta CAPI) para un contacto. Pensado
 * para webhooks externos o automatizaciones propias. Requiere el scope
 * `tracking:events`.
 *
 * Body: { contact_id? , phone?, event_name, value?, currency?, event_id? }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tracking:events')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') throw badRequest('Invalid JSON body')

    const eventName = String(body.event_name ?? '')
    if (!META_CAPI_EVENTOS.includes(eventName as MetaCapiEventName)) {
      throw badRequest(`event_name must be one of: ${META_CAPI_EVENTOS.join(', ')}`)
    }

    let contactId = typeof body.contact_id === 'string' ? body.contact_id : null
    if (!contactId && typeof body.phone === 'string') {
      const digits = normalizarTelefono(body.phone)
      const candidatos = [body.phone.trim(), digits].filter(Boolean) as string[]
      const { data } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .in('phone', candidatos)
        .limit(1)
        .maybeSingle()
      contactId = (data?.id as string | undefined) ?? null
    }
    if (!contactId) throw badRequest('A valid contact_id or phone is required')

    const valor = Number(body.value)
    const currency =
      typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)
        ? body.currency
        : undefined
    const eventId =
      typeof body.event_id === 'string' && body.event_id.trim()
        ? body.event_id.trim()
        : `${contactId}-${eventName}-${Date.now()}`

    const resultado = await enviarEventoMeta({
      accountId: ctx.accountId,
      contactId,
      connectionId:
        typeof body.connection_id === 'string' && body.connection_id.trim()
          ? body.connection_id.trim()
          : null,
      conversationId:
        typeof body.conversation_id === 'string' && body.conversation_id.trim()
          ? body.conversation_id.trim()
          : null,
      eventName,
      eventId,
      value: Number.isFinite(valor) && valor > 0 ? valor : undefined,
      currency,
    })

    return ok(
      resultado.enviado
        ? { enviado: true }
        : { enviado: false, motivo: resultado.motivo, detalle: resultado.detalle },
      resultado.enviado ? 200 : 202,
    )
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
