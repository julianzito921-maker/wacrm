import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const tCommon = getT('Api.common')

interface ContactRow {
  id: string
  name: string | null
  phone: string
  wa_username: string | null
  email: string | null
  company: string | null
  created_at: string
  deals?: { title: string | null; value: number | null; currency: string | null; stage: { name: string } | null }[]
  contact_tags?: { tags: { name: string } | null }[]
}

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  // RFC 4180: wrap when the value contains a delimiter, quote or newline,
  // and double any embedded quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvCell(v: unknown): string {
  return esc(v)
}

/**
 * GET /api/contacts/export
 *
 * Descarga todos los contactos de la cuenta como CSV (UTF-8 con BOM para
 * que Excel abra acentos bien). Incluye etiquetas y el deal activo de
 * cada contacto. Escrito con los mismos principios de tenancy que el
 * resto: la consulta sale por el cliente RLS scoped a la cuenta, nunca
 * con service role.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('contacts')
      .select(
        'id, name, phone, wa_username, email, company, created_at, ' +
          'deals(title, value, currency, stage:pipeline_stages(name)), ' +
          'contact_tags(tags(name))',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/contacts/export] fetch error:', error)
      return NextResponse.json(
        { error: tCommon('unknownError') },
        { status: 500 },
      )
    }

    const rows = (data ?? []) as unknown as ContactRow[]

    const header = [
      'name',
      'phone',
      'whatsapp_username',
      'email',
      'company',
      'tags',
      'active_deal',
      'deal_value',
      'deal_currency',
      'stage',
      'created_at',
    ]

    const lines = [header.join(',')]
    for (const c of rows) {
      const tags = (c.contact_tags ?? [])
        .map((ct) => ct.tags?.name)
        .filter((n): n is string => Boolean(n))
        .join(' | ')
      // El deal más reciente (last deal por created_at) como resumen.
      const deal = c.deals?.[0]
      lines.push(
        [
          csvCell(c.name),
          csvCell(c.phone),
          csvCell(c.wa_username),
          csvCell(c.email),
          csvCell(c.company),
          csvCell(tags),
          csvCell(deal?.title),
          csvCell(deal?.value),
          csvCell(deal?.currency),
          csvCell(deal?.stage?.name),
          csvCell(c.created_at),
        ].join(','),
      )
    }

    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n'

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="contacts.csv"',
      },
    })
  } catch (err) {
    // getCurrentAccount is the only thrower; toErrorResponse maps its
    // classified errors (401/403) and collapses unknown ones to 500.
    return toErrorResponse(err)
  }
}