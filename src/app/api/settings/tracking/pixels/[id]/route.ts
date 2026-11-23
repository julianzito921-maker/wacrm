import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

const CAMPOS =
  'id, platform, name, pixel_id, test_event_code, purchase_stage_id, active, created_at, access_token'

interface FilaPixel {
  id: string
  platform: string
  name: string
  pixel_id: string
  test_event_code: string | null
  purchase_stage_id: string | null
  active: boolean
  created_at: string
  access_token: string | null
}

function publica(fila: FilaPixel) {
  const { access_token, ...resto } = fila
  return { ...resto, has_token: Boolean(access_token) }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string') patch.name = body.name.trim()
    if (typeof body.pixel_id === 'string') patch.pixel_id = body.pixel_id.trim()
    if (typeof body.test_event_code === 'string' || body.test_event_code === null) {
      patch.test_event_code = String(body.test_event_code ?? '').trim() || null
    }
    if (typeof body.active === 'boolean') patch.active = body.active
    if (typeof body.purchase_stage_id === 'string' || body.purchase_stage_id === null) {
      const stageId = String(body.purchase_stage_id ?? '').trim() || null
      if (stageId) {
        const { data: etapa } = await ctx.supabase
          .from('pipeline_stages')
          .select('id, pipelines!inner(account_id)')
          .eq('id', stageId)
          .eq('pipelines.account_id', ctx.accountId)
          .maybeSingle()
        if (!etapa) {
          return NextResponse.json({ error: 'invalid_stage' }, { status: 400 })
        }
      }
      patch.purchase_stage_id = stageId
    }
    // Token vacío = conservar el actual.
    if (typeof body.access_token === 'string' && body.access_token.trim()) {
      patch.access_token = encrypt(body.access_token.trim())
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('tracking_pixels')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CAMPOS)
      .single()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'duplicate_pixel' }, { status: 409 })
      }
      throw new Error(error.message)
    }
    return NextResponse.json({ pixel: publica(data as FilaPixel) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await requireRole('admin')
    const { error } = await ctx.supabase
      .from('tracking_pixels')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
