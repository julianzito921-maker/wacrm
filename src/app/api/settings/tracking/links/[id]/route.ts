import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { UTM_KEYS, slugValido } from '@/lib/tracking/links'

const CAMPOS =
  'id, name, slug, platform, phone_number, prefilled_text, default_utm, active, created_at'

function utmLimpio(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  for (const key of UTM_KEYS) {
    const valor = (input as Record<string, unknown>)[key]
    if (typeof valor === 'string' && valor.trim()) {
      out[key] = valor.trim().slice(0, 300)
    }
  }
  return out
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
    if (typeof body.prefilled_text === 'string' || body.prefilled_text === null) {
      patch.prefilled_text = String(body.prefilled_text ?? '').trim() || null
    }
    if (typeof body.active === 'boolean') patch.active = body.active
    if (body.default_utm !== undefined) {
      patch.default_utm = utmLimpio(body.default_utm)
    }
    if (typeof body.slug === 'string' && body.slug.trim()) {
      const slug = body.slug.trim().toLowerCase()
      if (!slugValido(slug)) {
        return NextResponse.json({ error: 'invalid_slug' }, { status: 400 })
      }
      patch.slug = slug
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('tracking_links')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CAMPOS)
      .single()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'slug_taken' }, { status: 409 })
      }
      throw new Error(error.message)
    }
    return NextResponse.json({ link: data })
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
      .from('tracking_links')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
