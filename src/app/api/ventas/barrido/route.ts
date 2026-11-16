import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { barrerPendientes } from '@/lib/ventas/barrido'
import { barridoPendientesActivo } from '@/lib/messaging/interruptor'

/** Barrido de mensajes pendientes. Lo llama el cron interno cada 2 h (x-cron-secret = AUTOMATION_CRON_SECRET). */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const exp = Buffer.from(expected)
  if (supplied.length !== exp.length || !timingSafeEqual(supplied, exp)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Interruptor propio (nace apagado): es un proceso PROACTIVO —escribe a
  // quien se quedó callado— y sube los bloqueos del número.
  if (!(await barridoPendientesActivo())) {
    return NextResponse.json({ skipped: 'barrido apagado' })
  }
  const res = await barrerPendientes()
  console.log('[barrido]', JSON.stringify(res))
  return NextResponse.json(res)
}
