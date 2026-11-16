// ============================================================
// INTERRUPTOR GLOBAL — Fase 6 (§23)
//
// El freno de emergencia de toda la automatización saliente. Se lee de
// dos sitios:
//   - la variable de entorno (para apagarlo al desplegar o sin base);
//   - la tabla `messaging_flags` (para apagarlo en caliente desde el
//     panel y que siga apagado aunque el proceso se reinicie).
//
// Se cachea 30 s porque se consulta en cada envío y no puede costar una
// consulta por mensaje.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

const CACHE_MS = 30_000;

let cache: { valor: boolean; hasta: number } | null = null;

function delEntorno(): boolean | null {
  const v = process.env.WHATSAPP_AUTOMATION_ENABLED;
  if (v === undefined) return null;
  return !["0", "false", "off", "no"].includes(v.toLowerCase());
}

/** ¿Está permitida la automatización saliente? */
export async function automatizacionActiva(): Promise<boolean> {
  const entorno = delEntorno();
  if (entorno === false) return false; // el entorno manda para apagar
  const ahora = Date.now();
  if (cache && cache.hasta > ahora) return cache.valor;

  let valor = true;
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("messaging_flags")
      .select("valor")
      .eq("key", "automatizacion_activa")
      .maybeSingle();
    valor = (data as { valor?: boolean } | null)?.valor ?? true;
  } catch {
    valor = true; // sin lectura, no se frena nada por un fallo
  }
  cache = { valor, hasta: ahora + CACHE_MS };
  return valor;
}

/** Apaga o enciende la automatización (lo usa el panel y las alertas). */
export async function fijarInterruptor(
  activa: boolean,
  reason: string,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("messaging_flags")
      .upsert(
        {
          key: "automatizacion_activa",
          valor: activa,
          reason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
    cache = { valor: activa, hasta: Date.now() + CACHE_MS };
  } catch (err) {
    console.error(
      "[interruptor] no se pudo cambiar:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Sólo para las pruebas. */
export function limpiarCacheInterruptor(): void {
  cache = null;
}
