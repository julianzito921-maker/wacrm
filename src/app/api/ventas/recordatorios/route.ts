import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { enviarRecordatoriosVencidos } from '@/lib/ventas/paga-en'
import { recordatoriosPagoActivos } from '@/lib/messaging/interruptor'

/** Recordatorios de pago a la hora que dijo la clienta. Lo llama el cron interno cada minuto (x-cron-secret). */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const exp = Buffer.from(expected)
  if (supplied.length !== exp.length || !timingSafeEqual(supplied, exp)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Interruptor propio (nace apagado): este proceso fue el origen de los
  // mensajes fuera de la ventana de 24 h.
  if (!(await recordatoriosPagoActivos())) {
    return NextResponse.json({ skipped: 'recordatorios apagados' })
  }
  const res = await enviarRecordatoriosVencidos()
  if (res.enviados || res.saltados) console.log('[recordatorios de pago]', JSON.stringify(res))
  return NextResponse.json(res)
}
