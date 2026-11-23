import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  aplicarUtmsPorDefecto,
  construirUrlWhatsApp,
  generarTokenClic,
  limpiarParams,
} from '@/lib/tracking/links'

/**
 * GET /r/<slug>
 *
 * Enlace público de atribución. Registra el clic (sin IP cruda) y
 * redirige a WhatsApp con el texto prellenado y un «#token» de 6
 * caracteres que el webhook convierte en atribución del contacto.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params
  const db = supabaseAdmin()

  const { data: link } = await db
    .from('tracking_links')
    .select('id, account_id, connection_id, domain, phone_number, prefilled_text, default_utm, active, connection:whatsapp_connections(active)')
    .eq('slug', slug)
    .maybeSingle()

  if (!link?.active || !link.phone_number) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Dominio propio de la isla: si el enlace está atado a uno, el Host
  // debe coincidir. Así un slug de Isla 1 no se sirve en el dominio de Isla 2.
  const host = (request.headers.get('host') ?? '').split(':')[0].toLowerCase()
  if (link.domain && host !== String(link.domain).toLowerCase()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const conexion = (link as { connection?: { active?: boolean } | Array<{ active?: boolean }> }).connection
  const conexionActiva = Array.isArray(conexion) ? conexion[0]?.active : conexion?.active
  if (conexionActiva === false) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const url = new URL(request.url)
  const params = aplicarUtmsPorDefecto(
    limpiarParams(url.searchParams),
    link.default_utm as Record<string, string> | null,
  )

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  const sal = process.env.TRACKING_IP_SALT ?? process.env.ENCRYPTION_KEY ?? 'wacrm'
  const ipHash = createHash('sha256').update(`${sal}:${ip}`).digest('hex')

  let token: string | null = null
  const limite = checkRateLimit(`tracking-click:${ip}`, RATE_LIMITS.trackingClick)
  if (limite.success) {
    for (let intento = 0; intento < 3; intento += 1) {
      const candidato = generarTokenClic()
      const { error } = await db.from('tracking_clicks').insert({
        link_id: link.id,
        account_id: link.account_id,
        connection_id: link.connection_id ?? null,
        click_token: candidato,
        params,
        referrer: request.headers.get('referer')?.slice(0, 500) ?? null,
        ip_hash: ipHash.slice(0, 64),
        user_agent: request.headers.get('user-agent')?.slice(0, 400) ?? null,
      })
      if (!error) {
        token = candidato
        break
      }
      if (error.code !== '23505') {
        console.error('[tracking] no se pudo guardar el clic:', error.message)
        break
      }
    }
  }

  // Si el clic no se pudo registrar se redirige sin código: es preferible
  // perder la atribución a dejar un «#token» huérfano en el chat.
  const destino = construirUrlWhatsApp(
    link.phone_number as string,
    link.prefilled_text as string | null,
    token,
  )
  if (!destino) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const respuesta = NextResponse.redirect(destino, 302)
  respuesta.headers.set('cache-control', 'no-store')
  return respuesta
}
