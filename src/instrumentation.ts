// Cron interno: en Railway nada llama a los crons (docs/docker.md pide un programador externo),
// así que el propio servidor llama cada minuto a /api/automations/cron (esperas de las automatizaciones)
// y a /api/flows/cron (tiempos de espera de los flujos). Solo corre si AUTOMATION_CRON_SECRET existe;
// se apaga con CRON_INTERNO=off.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const secret = process.env.AUTOMATION_CRON_SECRET
  if (!secret || process.env.CRON_INTERNO === 'off') return
  const g = globalThis as { __cronInterno?: boolean }
  if (g.__cronInterno) return
  g.__cronInterno = true

  const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`
  const tick = async () => {
    for (const path of ['/api/automations/cron', '/api/flows/cron', '/api/ventas/recordatorios']) {
      try {
        await fetch(base + path, { headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(50_000) })
      } catch (err) {
        console.warn('[cron interno]', path, err instanceof Error ? err.message : err)
      }
    }
  }
  setTimeout(tick, 15_000)
  setInterval(tick, 60_000)

  // Barrido de pendientes cada 2 h (y uno a los 3 min de arrancar): contesta lo que se quedó sin respuesta.
  const barrido = async () => {
    try {
      await fetch(base + '/api/ventas/barrido', { headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(600_000) })
    } catch (err) {
      console.warn('[cron interno] barrido', err instanceof Error ? err.message : err)
    }
  }
  setTimeout(barrido, 180_000)
  setInterval(barrido, 2 * 3_600_000)
}
