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

/** Caché por interruptor (los procesos proactivos tienen el suyo). */
const cachePorClave = new Map<string, { valor: boolean; hasta: number }>();

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

/**
 * Lee un interruptor concreto. `porDefecto` decide qué hacer cuando la
 * fila no existe: la automatización general nace encendida, pero los
 * procesos proactivos (barrido, recordatorios) nacen apagados.
 */
export async function leerFlag(
  key: string,
  porDefecto: boolean,
): Promise<boolean> {
  const ahora = Date.now();
  const enCache = cachePorClave.get(key);
  if (enCache && enCache.hasta > ahora) return enCache.valor;
  let valor = porDefecto;
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("messaging_flags")
      .select("valor")
      .eq("key", key)
      .maybeSingle();
    const fila = data as { valor?: boolean } | null;
    if (fila && typeof fila.valor === "boolean") valor = fila.valor;
  } catch {
    valor = porDefecto;
  }
  cachePorClave.set(key, { valor, hasta: ahora + CACHE_MS });
  return valor;
}

/** ¿Se puede barrer conversaciones calladas? (proactivo, nace apagado) */
export function barridoPendientesActivo(): Promise<boolean> {
  return leerFlag("barrido_pendientes_activo", false);
}

/** ¿Se pueden mandar recordatorios de pago? (proactivo, nace apagado) */
export function recordatoriosPagoActivos(): Promise<boolean> {
  return leerFlag("recordatorios_pago_activos", false);
}

export async function fijarFlag(
  key: string,
  valor: boolean,
  reason: string,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("messaging_flags")
      .upsert(
        { key, valor, reason, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    cachePorClave.set(key, { valor, hasta: Date.now() + CACHE_MS });
  } catch (err) {
    console.error(
      "[interruptor] no se pudo cambiar el flag:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Sólo para las pruebas. */
export function limpiarCacheInterruptor(): void {
  cache = null;
  cachePorClave.clear();
}
