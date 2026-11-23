import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { TRACKING_PLATFORMS, type TrackingPlatform } from '@/lib/tracking/links'

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

/** Nunca devuelve el token: solo si existe. */
function publica(fila: FilaPixel) {
  const { access_token, ...resto } = fila
  return { ...resto, has_token: Boolean(access_token) }
}

async function etapaValida(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string,
  stageId: string | null | undefined,
): Promise<boolean> {
  if (!stageId) return true
  const { data } = await supabase
    .from('pipeline_stages')
    .select('id, pipelines!inner(account_id)')
    .eq('id', stageId)
    .eq('pipelines.account_id', accountId)
    .maybeSingle()
  return Boolean(data)
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('tracking_pixels')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    return NextResponse.json({
      pixels: ((data ?? []) as FilaPixel[]).map(publica),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const platform = String(body.platform ?? 'meta') as TrackingPlatform
    const name = String(body.name ?? '').trim()
    const pixelId = String(body.pixel_id ?? '').trim()
    const token = String(body.access_token ?? '').trim()
    const testEventCode = String(body.test_event_code ?? '').trim() || null
    const purchaseStageId = String(body.purchase_stage_id ?? '').trim() || null
    const active = body.active !== false

    if (!TRACKING_PLATFORMS.includes(platform)) {
      return NextResponse.json({ error: 'invalid_platform' }, { status: 400 })
    }
    if (!name || !pixelId || !token) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
    }
    if (purchaseStageId && !(await etapaValida(ctx.supabase, ctx.accountId, purchaseStageId))) {
      return NextResponse.json({ error: 'invalid_stage' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('tracking_pixels')
      .insert({
        account_id: ctx.accountId,
        platform,
        name,
        pixel_id: pixelId,
        access_token: encrypt(token),
        test_event_code: testEventCode,
        purchase_stage_id: purchaseStageId,
        active,
      })
      .select(CAMPOS)
      .single()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'duplicate_pixel' }, { status: 409 })
      }
      throw new Error(error.message)
    }
    return NextResponse.json({ pixel: publica(data as FilaPixel) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
