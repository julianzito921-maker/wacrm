/**
 * Programación del bloque «Intervalo inteligente».
 *
 * Funciones puras, sin dependencias nuevas: usan `Intl` para trabajar
 * con zonas IANA. El motor las llama al entrar al nodo; el formulario
 * las usa para la vista previa.
 */

import type { WaitSchedule } from "./types";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = lunes … 7 = domingo. */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterPara(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Partes de pared (año, mes, día, hora, minuto) en una zona IANA. */
export function partesEnZona(fecha: Date, timeZone: string): ZonedParts {
  const partes = formatterPara(timeZone).formatToParts(fecha);
  const valor = (tipo: string) =>
    Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const year = valor("year");
  const month = valor("month");
  const day = valor("day");
  const hour = valor("hour");
  const minute = valor("minute");
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return { year, month, day, hour, minute, weekday };
}

/** Desfase de la zona en ms (hora local de pared menos UTC). */
function offsetMs(fecha: Date, timeZone: string): number {
  const p = partesEnZona(fecha, timeZone);
  const comoUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return comoUtc - Math.floor(fecha.getTime() / 60_000) * 60_000;
}

/**
 * Instante UTC que corresponde a una hora de pared en la zona.
 * Itera dos veces para resolver el cambio de horario.
 */
export function instanteEnZona(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const comoUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = comoUtc;
  for (let i = 0; i < 2; i += 1) {
    const off = offsetMs(new Date(guess), timeZone);
    const next = comoUtc - off;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** «09:00» → 540 minutos. Devuelve null si no es válido. */
export function minutosDeHora(hora: string | undefined): number | null {
  if (!hora) return null;
  const m = hora.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export interface HorarioNormalizado {
  dias: Set<number>;
  desde: number;
  hasta: number;
}

/** Normaliza y valida la ventana. Null si no es utilizable. */
export function normalizarHorario(
  horario: WaitSchedule | null | undefined,
): HorarioNormalizado | null {
  const desde = minutosDeHora(horario?.desde);
  const hasta = minutosDeHora(horario?.hasta);
  if (desde === null || hasta === null) return null;
  const dias = new Set(
    (horario?.dias ?? [1, 2, 3, 4, 5]).filter((d) => d >= 1 && d <= 7),
  );
  if (dias.size === 0) return null;
  return { dias, desde, hasta };
}

interface Ventana {
  inicio: number;
  fin: number;
}

/** Ventana [inicio, fin) de un día local concreto. */
function ventanaDelDia(
  year: number,
  month: number,
  day: number,
  horario: HorarioNormalizado,
  timeZone: string,
): Ventana {
  const inicio = instanteEnZona(
    year,
    month,
    day,
    Math.floor(horario.desde / 60),
    horario.desde % 60,
    timeZone,
  ).getTime();
  const cruzaMedianoche = horario.hasta <= horario.desde;
  const diaFin = cruzaMedianoche ? day + 1 : day;
  const fin = instanteEnZona(
    year,
    month,
    diaFin,
    Math.floor(horario.hasta / 60),
    horario.hasta % 60,
    timeZone,
  ).getTime();
  return { inicio, fin };
}

export interface ProximaVentana {
  /** Cuándo hay que despertar la corrida. */
  despertarEn: Date;
  /** Inicio de la ventana que se está esperando. */
  inicio: Date;
}

/**
 * Próximo instante en el que la corrida debe despertar para caer dentro
 * de la ventana:
 *   - si ya está dentro, devuelve `now` (no hay que esperar);
 *   - si falta para abrir, devuelve la apertura;
 *   - si la ventana cruza medianoche, la apertura del día anterior cuenta.
 */
export function proximaVentana(
  now: Date,
  horario: WaitSchedule | null | undefined,
  timeZonePorDefecto: string,
): ProximaVentana | null {
  const normalizado = normalizarHorario(horario);
  if (!normalizado) return null;
  const timeZone = horario?.timezone || timeZonePorDefecto || "America/Mexico_City";
  const hoy = partesEnZona(now, timeZone);
  const nowMs = now.getTime();

  for (let offset = -1; offset <= 14; offset += 1) {
    const dia = new Date(Date.UTC(hoy.year, hoy.month - 1, hoy.day + offset));
    const year = dia.getUTCFullYear();
    const month = dia.getUTCMonth() + 1;
    const day = dia.getUTCDate();
    const weekday = ((dia.getUTCDay() + 6) % 7) + 1;
    if (!normalizado.dias.has(weekday)) continue;
    const ventana = ventanaDelDia(year, month, day, normalizado, timeZone);
    if (nowMs >= ventana.inicio && nowMs < ventana.fin) {
      return { despertarEn: now, inicio: new Date(ventana.inicio) };
    }
    if (ventana.inicio > nowMs) {
      return { despertarEn: new Date(ventana.inicio), inicio: new Date(ventana.inicio) };
    }
  }
  return null;
}

/** Segundos entre dos instantes, nunca negativos. */
export function segundosHasta(now: Date, target: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

/**
 * Calcula la espera del nodo según su modo:
 *   - `fecha`: hasta `fecha_objetivo`.
 *   - `horario`: hasta la próxima apertura (o 0 si ya está abierto).
 * Devuelve null si la configuración no es válida.
 */
export function esperaProgramadaSegundos(args: {
  modo: "fecha" | "horario";
  fecha_objetivo?: string;
  horario?: WaitSchedule | null;
  timeZonePorDefecto: string;
  now?: Date;
}): number | null {
  const now = args.now ?? new Date();
  if (args.modo === "fecha") {
    if (!args.fecha_objetivo) return null;
    const target = new Date(args.fecha_objetivo);
    if (Number.isNaN(target.getTime())) return null;
    return segundosHasta(now, target);
  }
  const ventana = proximaVentana(now, args.horario, args.timeZonePorDefecto);
  if (!ventana) return null;
  return segundosHasta(now, ventana.despertarEn);
}
