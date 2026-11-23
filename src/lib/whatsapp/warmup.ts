/**
 * Calentamiento progresivo por conexión.
 *
 * Día 1–2: 50 envíos masivos/día
 * Día 3–4: 120
 * Día 5–7: 250
 * Después: sin límite.
 *
 * Solo cuenta `source='difusion'` (broadcasts); las respuestas 1:1 no
 * gastan cupo. El contador se reserva en Postgres para que dos workers
 * no se pasen del límite.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const LIMITES = [50, 50, 120, 120, 250, 250, 250] as const;

export interface EstadoCalentamiento {
  dia: number | null;
  limite: number | null;
  habilitado: boolean;
}

export function diaCalentamiento(
  startedAt: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!startedAt) return null;
  const inicio = new Date(startedAt).getTime();
  if (!Number.isFinite(inicio)) return null;
  const dias = Math.floor((now.getTime() - inicio) / 86_400_000) + 1;
  return dias >= 1 ? dias : 1;
}

export function limiteCalentamiento(
  startedAt: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  const dia = diaCalentamiento(startedAt, now);
  if (dia === null || dia > LIMITES.length) return null;
  return LIMITES[dia - 1];
}

export function estadoCalentamiento(
  connection: { warmup_enabled?: boolean | null; warmup_started_at?: string | null },
  now: Date = new Date(),
): EstadoCalentamiento {
  if (!connection.warmup_enabled) {
    return { dia: null, limite: null, habilitado: false };
  }
  const dia = diaCalentamiento(connection.warmup_started_at, now);
  return {
    dia,
    limite: limiteCalentamiento(connection.warmup_started_at, now),
    habilitado: true,
  };
}

function diaUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserva un cupo de envío masivo para hoy. Devuelve true si se puede
 * mandar; false si ya se agotó el límite del día.
 */
export async function reservarCupoCalentamiento(
  db: SupabaseClient,
  args: {
    connectionId: string;
    warmupEnabled: boolean;
    warmupStartedAt: string | null;
    now?: Date;
  },
): Promise<{ permitido: boolean; limite: number | null; dia: number | null }> {
  if (!args.warmupEnabled) {
    return { permitido: true, limite: null, dia: null };
  }
  const now = args.now ?? new Date();
  const limite = limiteCalentamiento(args.warmupStartedAt, now);
  const dia = diaCalentamiento(args.warmupStartedAt, now);
  if (limite === null) {
    return { permitido: true, limite: null, dia };
  }
  const { data, error } = await db.rpc("reservar_envio_calentamiento", {
    p_connection_id: args.connectionId,
    p_day: diaUtc(now),
    p_limit: limite,
  });
  if (error) {
    // Si la reserva falla por infraestructura, no se bloquea el envío:
    // la conexión ya tiene otras compuertas (salud, opt-out, política).
    console.error("[warmup] no se pudo reservar cupo:", error.message);
    return { permitido: true, limite, dia };
  }
  return { permitido: data === true, limite, dia };
}

/** Estados que impiden envíos masivos de una conexión. */
export function conexionBloqueaMasivo(connection: {
  health_status?: string | null;
  restriction_scope?: string | null;
  quality_rating?: string | null;
}): { bloqueado: boolean; motivo: string | null } {
  const health = (connection.health_status ?? "healthy").toLowerCase();
  const scope = (connection.restriction_scope ?? "").toLowerCase();
  const quality = (connection.quality_rating ?? "").toUpperCase();
  if (health === "blocked" || scope === "all") {
    return {
      bloqueado: true,
      motivo: "La conexión está bloqueada por Meta; no se permiten envíos.",
    };
  }
  if (health === "restricted" || scope === "mass") {
    return {
      bloqueado: true,
      motivo: "Meta restringió los mensajes iniciados por el negocio en esta conexión.",
    };
  }
  if (quality === "RED") {
    return {
      bloqueado: true,
      motivo: "La calidad del número está en RED; se pausan los envíos masivos.",
    };
  }
  return { bloqueado: false, motivo: null };
}
