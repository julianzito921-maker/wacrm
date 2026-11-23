// Retira del CRM el número de una o varias cuentas (baneado o sin acceso):
// ficha en messaging_alerts, corta esperas/cola/corridas, apaga flujos y
// automatizaciones, borra las plantillas de esa WABA y la conexión.
// NO borra contactos ni conversaciones.
// Uso: railway run --service wacrm npx tsx --tsconfig tsconfig.json scripts/retirar_numero.ts <account_id> "<motivo>" [<account_id> "<motivo>" ...]
import { retirarNumero } from '../src/lib/messaging/retiro'
;(async () => {
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    console.log(JSON.stringify(await retirarNumero(a[i], a[i + 1] ?? 'retiro manual'), null, 1))
  }
})()
