// Convivencia entre el Flow Builder y la IA (regla de Julián, 22-nov-2026).

/**
 * ¿El flujo visual es dueño de este mensaje? Sí, si lo consumió (avanzó,
 * arrancó, terminó, Smart Delay…) o si el contacto sigue con una corrida
 * activa aunque el mensaje no la haya movido (fallback «ignore»). En ese
 * caso nadie más contesta: ni el agente, ni la IA, ni las automatizaciones.
 */
export function flujoEsDuenoDelMensaje(r: { consumed: boolean; flow_run_id?: string }): boolean {
  return r.consumed || !!r.flow_run_id
}
