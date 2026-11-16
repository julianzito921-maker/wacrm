import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { metricasDeRiesgo } from '@/lib/messaging/riesgo'
import { automatizacionActiva } from '@/lib/messaging/interruptor'
import { esSimulacion } from '@/lib/messaging/send'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/messaging/riesgo
 *
 * Panel de riesgo de la capa de mensajería (fase 6). Devuelve:
 *   - las métricas de la ventana pedida (`?horas=24`, por defecto 24);
 *   - la métrica que más pesa: outbound/usuario;
 *   - el estado de los frenos (interruptor global y modo simulación);
 *   - las últimas alertas registradas.
 *
 * Disponible para cualquier miembro de la cuenta.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const horas = Math.min(Math.max(Number(url.searchParams.get('horas')) || 24, 1), 168)

    const [metricas, activa, simulacion, alertas] = await Promise.all([
      metricasDeRiesgo(accountId, horas),
      automatizacionActiva(),
      Promise.resolve(esSimulacion()),
      supabaseAdmin()
        .from('messaging_alerts')
        .select('regla, severidad, detalle, accion, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(20),
    ])

    return NextResponse.json({
      metricas,
      frenos: {
        automatizacion_activa: activa,
        modo_simulacion: simulacion,
      },
      alertas: alertas.data ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
