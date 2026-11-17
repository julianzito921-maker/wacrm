import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin as automationsDb } from '@/lib/automations/admin-client'
import {
  claimPendingExecution,
  expireAwaitingReplies,
  requeueStalledExecutions,
  resumePendingExecution,
} from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { checkRunTimeout, markRunTimedOut } from '@/lib/flows/timeout'
import { resumeSaveReplyTimeout } from '@/lib/flows/engine'
import { procesarLote } from '@/lib/messaging/cola'
import { evaluarAlertas } from '@/lib/messaging/riesgo'
import { revisarCalidadDeNumeros } from '@/lib/messaging/calidad'

/**
 * UN SOLO CRON PARA TODO (fase 4, §22).
 *
 * Antes había cuatro endpoints que había que programar por separado
 * (`/api/flows/cron`, `/api/automations/cron`, `/api/ventas/barrido`,
 * `/api/ventas/recordatorios`). Ahora este barre, en este orden:
 *
 *   1. La COLA DE SALIDA: reintentos con espera creciente.
 *   2. Los flujos: ejecuciones abandonadas y «guardar respuesta» sin
 *      contestación.
 *   3. Las automatizaciones: esperas vencidas y ejecuciones atascadas.
 *
 * Los endpoints antiguos siguen existiendo por compatibilidad, pero
 * basta con programar este.
 *
 * Requiere el secreto compartido `AUTOMATION_CRON_SECRET` en la
 * cabecera `x-cron-secret`.
 */

const TIMEOUT_SWEEP_PAGE_SIZE = 500
const TIMEOUT_SWEEP_MAX_PAGES = 20

interface TimedOutRunRow {
  id: string
  last_advanced_at: string
  fallback_policy: unknown
}

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return false
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!process.env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = automationsDb()
  const ahora = new Date()

  // ---- 1. Cola de salida: reintentos -------------------------------
  const cola = await procesarLote(50)

  // ---- 1b. Alertas de riesgo (§22) ---------------------------------
  //    Se revisa cada cuenta con actividad en la última hora: si algo se
  //    desboca (racha, relación fuera de rango, errores) se avisa, se
  //    pausa el flujo culpable o se apaga la automatización.
  let alertas = 0
  {
    const { data: cuentas } = await admin
      .from('outbound_message_log')
      .select('account_id')
      .gte('created_at', new Date(ahora.getTime() - 3_600_000).toISOString())
      .limit(500)
    const unicas = [...new Set((cuentas ?? []).map((c) => c.account_id))]
    for (const cuenta of unicas) {
      try {
        alertas += (await evaluarAlertas(cuenta)).length
      } catch (err) {
        console.error('[messaging-cron] alertas:', err)
      }
    }
  }

  // ---- 1c. Calidad del número (§Meta) ------------------------------
  //    Único aviso público de Meta sobre «cómo va el número»: si baja a
  //    amarillo se avisa, y si está en rojo se apaga la automatización
  //    sola, para no seguir mandando con el número en riesgo.
  let calidad: Awaited<ReturnType<typeof revisarCalidadDeNumeros>> = []
  try {
    calidad = await revisarCalidadDeNumeros()
  } catch (err) {
    console.error('[messaging-cron] calidad:', err)
  }

  // ---- 2. Flujos: «guardar respuesta» sin contestación --------------
  let rescatados = 0
  {
    const corte = ahora.getTime() - 60_000
    const { data: activasCrudas } = await admin
      .from('flow_runs')
      .select('id, flow_id, current_node_key, last_advanced_at')
      .eq('status', 'active')
      .limit(TIMEOUT_SWEEP_PAGE_SIZE)
    const activas = (activasCrudas ?? []).filter(
      (r) => r.current_node_key && new Date(r.last_advanced_at ?? 0).getTime() <= corte,
    )
    const claves = [
      ...new Set(activas.map((r) => r.current_node_key).filter(Boolean)),
    ] as string[]
    if (activas.length && claves.length) {
      const { data: nodos } = await admin
        .from('flow_nodes')
        .select('flow_id, node_key, node_type')
        .in('node_key', claves)
      const porFlujo = new Map(
        (nodos ?? [])
          .filter((n) => n.node_type === 'save_reply')
          .map((n) => [`${n.flow_id}:${n.node_key}`, n]),
      )
      for (const r of activas) {
        if (!porFlujo.has(`${r.flow_id}:${r.current_node_key}`)) continue
        try {
          if (await resumeSaveReplyTimeout(admin, r.id, ahora)) rescatados += 1
        } catch (err) {
          console.error('[messaging-cron] save_reply:', err)
        }
      }
    }
  }

  // ---- 3. Flujos: ejecuciones abandonadas --------------------------
  let swept = 0
  for (let page = 0; page < TIMEOUT_SWEEP_MAX_PAGES; page += 1) {
    const { data: runs, error } = await admin.rpc('list_timed_out_flow_runs', {
      p_now: ahora.toISOString(),
      p_limit: TIMEOUT_SWEEP_PAGE_SIZE,
    })
    if (error) {
      console.error('[messaging-cron] barrido de flujos:', error.message)
      break
    }
    const rows = (runs ?? []) as TimedOutRunRow[]
    let enEstaPagina = 0
    for (const r of rows) {
      const check = checkRunTimeout(r.last_advanced_at, r.fallback_policy, ahora)
      if (!check.timedOut) continue
      if (await markRunTimedOut(admin, r.id, check, 'stale_sweep', ahora)) enEstaPagina += 1
    }
    swept += enEstaPagina
    if (rows.length < TIMEOUT_SWEEP_PAGE_SIZE || enEstaPagina === 0) break
  }

  // ---- 4. Automatizaciones: esperas y atascos ----------------------
  const expired = await expireAwaitingReplies()
  const requeued = await requeueStalledExecutions()
  let processed = 0
  {
    const { data: due, error } = await admin
      .from('automation_pending_executions')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', ahora.toISOString())
      .order('run_at', { ascending: true })
      .limit(50)
    if (error) {
      console.error('[messaging-cron] esperas de automatización:', error.message)
    } else {
      for (const row of due ?? []) {
        if (!(await claimPendingExecution(row.id as string))) continue
        await resumePendingExecution({
          id: row.id as string,
          automation_id: row.automation_id as string,
          account_id: row.account_id as string,
          user_id: row.user_id as string,
          contact_id: (row.contact_id as string | null) ?? null,
          log_id: (row.log_id as string | null) ?? null,
          parent_step_id: (row.parent_step_id as string | null) ?? null,
          branch: (row.branch as 'yes' | 'no' | null) ?? null,
          next_step_position: row.next_step_position as number,
          parked_step_id: (row.parked_step_id as string | null) ?? null,
          context: (row.context as AutomationContext) ?? {},
        })
        processed += 1
      }
    }
  }

  return NextResponse.json({
    cola,
    alertas,
    calidad,
    flujos: { rescatados, swept },
    automatizaciones: { processed, expired, requeued },
  })
}
