import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api'
import {
  LINK_PLATFORMS,
  UTM_KEYS,
  construirUrlEnlace,
  generarTokenClic,
  normalizarTelefono,
  slugValido,
  slugify,
  type LinkPlatform,
} from '@/lib/tracking/links'

const CAMPOS =
  'id, name, slug, platform, phone_number, prefilled_text, default_utm, active, created_at'

interface FilaEnlace {
  id: string
  name: string
  slug: string
  platform: string
  phone_number: string | null
  prefilled_text: string | null
  default_utm: Record<string, string> | null
  active: boolean
  created_at: string
}

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

function baseUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
}

function publico(fila: FilaEnlace, base: string) {
  return {
    ...fila,
    url: construirUrlEnlace(base, fila.slug, fila.default_utm ?? {}),
  }
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('tracking_links')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    const base = baseUrl(request)
    return NextResponse.json({
      links: ((data ?? []) as FilaEnlace[]).map((f) => publico(f, base)),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const name = String(body.name ?? '').trim()
    const platform = String(body.platform ?? 'meta') as LinkPlatform
    const prefilled = String(body.prefilled_text ?? '').trim() || null
    const active = body.active !== false
    const defaultUtm = utmLimpio(body.default_utm)

    if (!name) {
      return NextResponse.json({ error: 'missing_name' }, { status: 400 })
    }
    if (!LINK_PLATFORMS.includes(platform)) {
      return NextResponse.json({ error: 'invalid_platform' }, { status: 400 })
    }

    // Número real de la conexión de WhatsApp de la cuenta.
    const { data: cfg } = await ctx.supabase
      .from('whatsapp_config')
      .select('id, phone_number_id, access_token, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!cfg || cfg.status !== 'connected') {
      return NextResponse.json({ error: 'whatsapp_disconnected' }, { status: 409 })
    }
    let telefono: string | null = null
    try {
      const info = await getPhoneNumberHealth({
        phoneNumberId: cfg.phone_number_id as string,
        accessToken: decrypt(cfg.access_token as string),
      })
      telefono = normalizarTelefono(info.display_phone_number)
    } catch (err) {
      console.error(
        '[tracking/links] no se pudo leer el número:',
        err instanceof Error ? err.message : err,
      )
      return NextResponse.json({ error: 'phone_unavailable' }, { status: 502 })
    }
    if (!telefono) {
      return NextResponse.json({ error: 'phone_unavailable' }, { status: 502 })
    }

    const pedido = String(body.slug ?? '').trim()
    const baseSlug = slugValido(pedido) ? pedido : slugify(pedido || name)

    for (let intento = 0; intento < 5; intento += 1) {
      const slug =
        intento === 0
          ? baseSlug
          : `${baseSlug.slice(0, 44)}-${generarTokenClic().slice(0, 4)}`
      const { data, error } = await ctx.supabase
        .from('tracking_links')
        .insert({
          account_id: ctx.accountId,
          name,
          slug,
          platform,
          whatsapp_config_id: cfg.id,
          phone_number: telefono,
          prefilled_text: prefilled,
          default_utm: defaultUtm,
          active,
        })
        .select(CAMPOS)
        .single()
      if (!error) {
        return NextResponse.json(
          { link: publico(data as FilaEnlace, baseUrl(request)) },
          { status: 201 },
        )
      }
      if (error.code !== '23505') throw new Error(error.message)
    }
    return NextResponse.json({ error: 'slug_taken' }, { status: 409 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
