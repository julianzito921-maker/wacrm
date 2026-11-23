import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

interface FilaStats {
  node_key: string
  entradas: number | string
  avances: number | string
}

/**
 * GET /api/flows/[id]/stats
 *
 * ENTRADAS / AVANCES por nodo para la tarjeta del lienzo. Sale del RPC
 * `flow_node_stats` (migración 081), que cuenta corridas distintas y
 * respeta la RLS de flow_run_events. Por defecto, últimos 30 días.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 })
  }

  const dias = Number(new URL(request.url).searchParams.get('days')) || 30
  const desde = new Date(
    Date.now() - Math.min(Math.max(dias, 1), 365) * 86_400_000,
  ).toISOString()

  const { data, error } = await supabase.rpc('flow_node_stats', {
    p_flow_id: id,
    p_desde: desde,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const nodes = ((data ?? []) as FilaStats[]).map((f) => ({
    node_key: f.node_key,
    entradas: Number(f.entradas) || 0,
    avances: Number(f.avances) || 0,
  }))
  return NextResponse.json({ nodes })
}
