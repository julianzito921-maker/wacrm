import { supabaseAdmin } from '@/lib/flows/admin-client'
import { guardarValor } from '@/lib/ventas/contact-values'
import {
  CLICK_ID_KEYS,
  UTM_KEYS,
  aplicarUtmsPorDefecto,
  extraerCodigo,
} from './links'

export interface AtribucionEntrante {
  source: string | null
  /** Isla que originó el clic; si falta, se usa la tabla legacy. */
  connectionId?: string | null
  linkId?: string | null
  clickId?: string | null
  ctwaClid?: string | null
  campaign?: string | null
  adset?: string | null
  ad?: string | null
  creative?: string | null
  clickIds?: Record<string, string>
  utm?: Record<string, string>
  raw?: Record<string, unknown>
  /** Solo para los campos personalizados de compatibilidad. */
  linkSlug?: string | null
  userId?: string | null
}

/**
 * Guarda la atribución del contacto (una fila) y mantiene los campos
 * personalizados que ya usaba CAPI antes de esta tabla. Nunca lanza.
 */
export async function upsertContactAttribution(
  args: AtribucionEntrante & { accountId: string; contactId: string },
): Promise<void> {
  try {
    const db = supabaseAdmin()
    const ahora = new Date().toISOString()

    if (args.connectionId) {
      const { data: existenteIsla } = await db
        .from('contact_attribution_islas')
        .select('first_seen_at')
        .eq('contact_id', args.contactId)
        .eq('connection_id', args.connectionId)
        .maybeSingle()
      const { error: errorIsla } = await db
        .from('contact_attribution_islas')
        .upsert(
          {
            contact_id: args.contactId,
            connection_id: args.connectionId,
            account_id: args.accountId,
            source: args.source,
            link_id: args.linkId ?? null,
            click_id: args.clickId ?? null,
            ctwa_clid: args.ctwaClid ?? null,
            campaign: args.campaign ?? null,
            adset: args.adset ?? null,
            ad: args.ad ?? null,
            creative: args.creative ?? null,
            click_ids: args.clickIds ?? {},
            utm: args.utm ?? {},
            raw: args.raw ?? {},
            first_seen_at:
              (existenteIsla?.first_seen_at as string | undefined) ?? ahora,
            last_seen_at: ahora,
          },
          { onConflict: 'contact_id,connection_id' },
        )
      if (errorIsla) {
        console.error(
          '[tracking] no se pudo guardar la atribución por isla:',
          errorIsla.message,
        )
      }
      return
    }

    const { data: existente } = await db
      .from('contact_attribution')
      .select('first_seen_at')
      .eq('contact_id', args.contactId)
      .maybeSingle()

    const { error } = await db.from('contact_attribution').upsert(
      {
        contact_id: args.contactId,
        account_id: args.accountId,
        source: args.source,
        link_id: args.linkId ?? null,
        click_id: args.clickId ?? null,
        ctwa_clid: args.ctwaClid ?? null,
        campaign: args.campaign ?? null,
        adset: args.adset ?? null,
        ad: args.ad ?? null,
        creative: args.creative ?? null,
        click_ids: args.clickIds ?? {},
        utm: args.utm ?? {},
        raw: args.raw ?? {},
        first_seen_at: (existente?.first_seen_at as string | undefined) ?? ahora,
        last_seen_at: ahora,
      },
      { onConflict: 'contact_id' },
    )
    if (error) {
      console.error('[tracking] no se pudo guardar la atribución:', error.message)
      return
    }

    // Compatibilidad con lo que ya leía CAPI y el inbox.
    if (args.userId) {
      if (args.ctwaClid) {
        await guardarValor(args.accountId, args.userId, args.contactId, 'ctwa_clid', args.ctwaClid)
      }
      if (args.ad) {
        await guardarValor(args.accountId, args.userId, args.contactId, 'anuncio_id', args.ad)
      }
      if (args.ctwaClid || args.ad) {
        await guardarValor(args.accountId, args.userId, args.contactId, 'anuncio_fecha', ahora)
      }
      if (args.linkSlug) {
        await guardarValor(args.accountId, args.userId, args.contactId, 'tracking_link', args.linkSlug)
      }
    }
  } catch (err) {
    console.error(
      '[tracking] error guardando la atribución:',
      err instanceof Error ? err.message : err,
    )
  }
}

/** ctwa_clid guardado, si lo hay, para la isla concreta. */
export async function leerAtribucion(
  accountId: string,
  contactId: string,
  connectionId?: string | null,
): Promise<{ ctwa_clid: string | null } | null> {
  const db = supabaseAdmin()
  if (connectionId) {
    const { data } = await db
      .from('contact_attribution_islas')
      .select('ctwa_clid')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('connection_id', connectionId)
      .maybeSingle()
    if (!data) return null
    return { ctwa_clid: (data as { ctwa_clid?: string | null }).ctwa_clid ?? null }
  }
  const { data } = await db
    .from('contact_attribution')
    .select('ctwa_clid')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (!data) return null
  return { ctwa_clid: (data as { ctwa_clid?: string | null }).ctwa_clid ?? null }
}

/**
 * Si el primer mensaje trae un «#token» de un enlace, ata el clic al
 * contacto y devuelve el texto sin el código. Solo borra cuando el clic
 * existe y se reclama: un «#ff0000» no se toca.
 */
export async function reclamarCodigoDeEnlace(args: {
  accountId: string
  userId: string
  contactId: string
  texto: string | null | undefined
}): Promise<{ texto: string } | null> {
  try {
    const extraido = extraerCodigo(args.texto)
    if (!extraido) return null

    const db = supabaseAdmin()
    const { data: click } = await db
      .from('tracking_clicks')
      .select('id, link_id, params, contact_id, account_id, connection_id')
      .eq('click_token', extraido.token)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (!click || click.contact_id) return null

    const { data: link } = await db
      .from('tracking_links')
      .select('id, slug, platform, default_utm, active, connection_id')
      .eq('id', click.link_id)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (!link?.active) return null

    const { data: reclamado } = await db
      .from('tracking_clicks')
      .update({
        contact_id: args.contactId,
        claimed_at: new Date().toISOString(),
      })
      .eq('id', click.id)
      .is('contact_id', null)
      .select('id')
    if (!Array.isArray(reclamado) || reclamado.length !== 1) return null

    const params = aplicarUtmsPorDefecto(
      (click.params ?? {}) as Record<string, string>,
      link.default_utm as Record<string, string>,
    )
    const utm: Record<string, string> = {}
    for (const k of UTM_KEYS) if (params[k]) utm[k] = params[k]
    const clickIds: Record<string, string> = {}
    for (const k of CLICK_ID_KEYS) if (params[k]) clickIds[k] = params[k]

    await upsertContactAttribution({
      accountId: args.accountId,
      userId: args.userId,
      contactId: args.contactId,
      source: link.platform as string,
      connectionId:
        (click as { connection_id?: string | null }).connection_id ??
        (link as { connection_id?: string | null }).connection_id ??
        null,
      linkId: click.link_id as string,
      clickId: click.id as string,
      campaign: params.utm_campaign ?? null,
      adset: null,
      ad: params.utm_content ?? null,
      creative: params.utm_term ?? null,
      utm,
      clickIds,
      raw: params,
      linkSlug: link.slug as string,
    })

    return { texto: extraido.limpio }
  } catch (err) {
    console.error(
      '[tracking] no se pudo reclamar el código del enlace:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
