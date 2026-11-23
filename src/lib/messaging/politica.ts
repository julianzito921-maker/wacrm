// ============================================================
// POLÍTICA DE SALIDA — Fase 2
//
// La capa que decide si un mensaje PUEDE salir. Vive en un solo sitio
// (nada de reglas repartidas por cada workflow) y todos los topes son
// configurables por entorno.
//
// Reglas, en orden:
//   1. Interruptor general: si la automatización está apagada, sólo
//      pasa lo que manda una persona desde el CRM.
//   2. Ventana de 24 h: fuera de la ventana de servicio, un mensaje
//      libre es una violación de política de WhatsApp (error 131047).
//      Sólo se permite plantilla.
//   3. Duplicado: el mismo contenido al mismo contacto dentro de la
//      ventana de deduplicación, no sale dos veces.
//   4. Límites: por minuto, por hora, por día y — el que más pesa —
//      cuántos mensajes seguidos sin que la clienta conteste.
//   5. Separación mínima entre mensajes automáticos.
//
// Qué NO hace todavía (fases siguientes): no encola, no cancela
// mensajes ya programados y no mezcla el estado de conversación.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { admiteAutomatico, estaEnBaja, leerEstado } from "./estado";
import { automatizacionActiva } from "./interruptor";
import type { ContextoSalida, TipoSalida } from "./send";

export interface Decision {
  permitido: boolean;
  /** Regla que lo frenó; null cuando pasa. */
  motivo: string | null;
  /** Texto legible para el registro y para el panel. */
  detalle?: string;
  /** true = se registra pero se deja pasar (modo observación). */
  soloAviso?: boolean;
}

const ACTIVO = (v: string | undefined, porDefecto: boolean): boolean =>
  v === undefined ? porDefecto : !["0", "false", "off", "no"].includes(v.toLowerCase());

const NUM = (v: string | undefined, porDefecto: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
};

/** Topes y ventanas, todos configurables sin tocar código. */
export const TOPES = {
  /** Interruptor de emergencia: apaga toda la automatización saliente. */
  automatizacionActiva: () => ACTIVO(process.env.WHATSAPP_AUTOMATION_ENABLED, true),
  /** Interruptor de la propia capa (para medir sin bloquear). */
  enforce: () => ACTIVO(process.env.WHATSAPP_SAFETY_ENFORCE, true),
  /** Horas de ventana de servicio (con margen sobre las 24 h de Meta). */
  ventanaHoras: () => NUM(process.env.WHATSAPP_WINDOW_HOURS, 23.5),
  /**
   * Regla anti-baneo (18-nov-2026): máximo 2 mensajes seguidos sin que la
   * clienta conteste. Lo que no quepa va en el siguiente turno.
   */
  maxSeguidos: () => NUM(process.env.SAFETY_MAX_CONSECUTIVE, 2),
  maxPorMinuto: () => NUM(process.env.SAFETY_MAX_PER_MINUTE, 3),
  /**
   * Ráfaga: cuántos mensajes pueden salir en una ventana corta. Es la
   * regla que hubiera frenado el flujo que nos baneó (6 bloques de texto
   * y multimedia en 60 s). Deja pasar una entrega pedida repartida con
   * esperas, pero corta la ametralladora.
   */
  ventanaRafagaSegundos: () => NUM(process.env.SAFETY_BURST_WINDOW_SECONDS, 300),
  maxEnRafaga: () => NUM(process.env.SAFETY_MAX_IN_WINDOW, 5),
  maxPorHora: () => NUM(process.env.SAFETY_MAX_PER_HOUR, 20),
  maxPorDia: () => NUM(process.env.SAFETY_MAX_PER_DAY, 60),
  dupMinutos: () => NUM(process.env.SAFETY_DUP_WINDOW_MINUTES, 10),
  /**
   * Personas distintas a las que se les puede mandar plantilla (mensaje
   * que inicia la empresa) en 24 h. Sin verificar el negocio Meta da 250;
   * si Meta sube el nivel, se cambia por entorno sin desplegar.
   */
  maxPersonasPlantillaDia: () => NUM(process.env.WHATSAPP_LIMITE_PERSONAS_DIA, 250),
  separacionMinimaSegundos: () => NUM(process.env.SAFETY_MIN_GAP_SECONDS, 2),
};

/** Tipos que Meta acepta fuera de la ventana de 24 h. */
const PERMITIDOS_FUERA_DE_VENTANA: TipoSalida[] = ["template"];

/** Orígenes que son automatización (los que el interruptor apaga). */
const AUTOMATICOS = new Set<ContextoSalida["source"]>([
  "flujo",
  "automatizacion",
  "ia",
  "agente",
  "ventas",
]);

export function esAutomatico(origen: ContextoSalida["source"]): boolean {
  return AUTOMATICOS.has(origen);
}

/**
 * ¿Mandarle plantilla a este contacto rebasa el tope diario de personas?
 * Un contacto que ya recibió plantilla hoy no cuenta doble.
 */
export function rebasaLimitePersonas(
  contactosHoy: Array<string | null>,
  contactId: string | null | undefined,
  limite: number,
): boolean {
  const distintos = new Set(contactosHoy.filter((c): c is string => Boolean(c)));
  if (contactId && distintos.has(contactId)) return false;
  return distintos.size >= limite;
}

interface Fila {
  created_at: string;
  content_hash: string | null;
}

/**
 * Decide si el envío puede salir. Nunca lanza: ante cualquier duda de
 * lectura, deja pasar (la duda no puede cortar la conversación; el
 * registro queda igual).
 */
export async function decidirSalida(args: {
  ctx: ContextoSalida;
  tipo: TipoSalida;
  contenido?: string | null;
  /** Hash del contenido; si no se pasa, no se evalúa el duplicado. */
  hash?: string | null;
}): Promise<Decision> {
  const { ctx, tipo, hash } = args;
  const automatico = esAutomatico(ctx.source);

  // 1) Interruptor general (§23): apaga lo automático, deja lo humano.
  //    Se lee del entorno Y de la base, para poder apagarlo en caliente.
  if (automatico && !(await automatizacionActiva())) {
    return {
      permitido: false,
      motivo: "automation_disabled",
      detalle: "La automatización está apagada (WHATSAPP_AUTOMATION_ENABLED=false).",
    };
  }

  // 1b) Tope diario de personas para plantillas (mensajes que inicia la
  //     empresa). Es un límite duro de Meta: se frena siempre, aunque la
  //     capa esté en modo observación, porque Meta lo rechazaría igual y
  //     cada rechazo pesa en la calidad del número.
  if (tipo === "template") {
    try {
      const db = supabaseAdmin();
      const { data } = await db
        .from("outbound_message_log")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .eq("message_type", "template")
        .eq("status", "sent")
        .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .limit(5000);
      const contactos = ((data as Array<{ contact_id?: string | null }> | null) ?? []).map(
        (f) => f.contact_id ?? null,
      );
      const limite = TOPES.maxPersonasPlantillaDia();
      if (rebasaLimitePersonas(contactos, ctx.contactId, limite)) {
        return {
          permitido: false,
          motivo: "limit_unique_daily",
          detalle: `Ya se mandó plantilla a ${limite} personas distintas en 24 h (límite de Meta sin verificar el negocio).`,
        };
      }
    } catch {
      // sin lectura no se frena: Meta tiene la última palabra
    }
  }

  // Sin conversación no hay nada que evaluar (no debería pasar).
  if (!ctx.conversationId) return { permitido: true, motivo: null };

  const avisoPrev = !TOPES.enforce();
  const frenarAntes = (motivo: string, detalle: string): Decision =>
    avisoPrev
      ? { permitido: true, motivo, detalle, soloAviso: true }
      : { permitido: false, motivo, detalle };

  // Fase 3: estado de la conversación y baja voluntaria. Una persona al
  // mando o una clienta que pidió que no le escribamos son las dos
  // razones por las que la automatización tiene que callarse.
  if (automatico) {
    const estado = await leerEstado(ctx.conversationId);
    if (!admiteAutomatico(estado)) {
      return frenarAntes(
        estado === "OPT_OUT" ? "opt_out" : "state_blocked",
        estado === "OPT_OUT"
          ? "La clienta pidió que no se le escriba."
          : `La conversación está en «${estado}»: la lleva una persona o está en pausa.`,
      );
    }
    if (ctx.contactId && (await estaEnBaja(ctx.contactId))) {
      return frenarAntes(
        "opt_out",
        "El contacto tiene baja voluntaria registrada (no me escribas).",
      );
    }
  }

  let filas: Fila[] = [];
  let ultimoEntrante: string | null = null;
  try {
    const db = supabaseAdmin();
    const desde = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [conv, recientes] = await Promise.all([
      db
        .from("conversations")
        .select("last_inbound_at")
        .eq("id", ctx.conversationId)
        .maybeSingle(),
      db
        .from("outbound_message_log")
        .select("created_at, content_hash")
        .eq("conversation_id", ctx.conversationId)
        .in("status", ["sent", "blocked"])
        .gte("created_at", desde)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    ultimoEntrante =
      (conv.data as { last_inbound_at?: string | null } | null)?.last_inbound_at ?? null;
    filas = (recientes.data as Fila[] | null) ?? [];
  } catch {
    // Si no se puede leer, no se bloquea: el registro de la fase 1 ya
    // dejó constancia del envío.
    return { permitido: true, motivo: null };
  }

  const ahora = Date.now();
  const aviso = !TOPES.enforce();

  const frenar = (motivo: string, detalle: string): Decision =>
    aviso
      ? { permitido: true, motivo, detalle, soloAviso: true }
      : { permitido: false, motivo, detalle };

  // 2) Ventana de 24 h (sólo para mensajes libres).
  if (!PERMITIDOS_FUERA_DE_VENTANA.includes(tipo)) {
    const limite = ahora - TOPES.ventanaHoras() * 3_600_000;
    const dentro =
      ultimoEntrante === null ? false : new Date(ultimoEntrante).getTime() >= limite;
    if (!dentro) {
      return frenar(
        "window_24h",
        ultimoEntrante
          ? "Han pasado más de 24 h desde el último mensaje de la clienta."
          : "La clienta nunca ha escrito a este número.",
      );
    }
  }

  // 3) Duplicado exacto reciente.
  if (hash) {
    const dupDesde = ahora - TOPES.dupMinutos() * 60_000;
    if (filas.some((f) => f.content_hash === hash && new Date(f.created_at).getTime() >= dupDesde)) {
      return frenar(
        "duplicate",
        `El mismo contenido ya se envió a esta conversación en los últimos ${TOPES.dupMinutos()} minutos.`,
      );
    }
  }

  // 4) Límites por tiempo.
  const enVentana = (minutos: number) =>
    filas.filter((f) => new Date(f.created_at).getTime() >= ahora - minutos * 60_000).length;

  if (enVentana(1) >= TOPES.maxPorMinuto()) {
    return frenar("limit_per_minute", `Más de ${TOPES.maxPorMinuto()} mensajes por minuto.`);
  }
  if (enVentana(60) >= TOPES.maxPorHora()) {
    return frenar("limit_per_hour", `Más de ${TOPES.maxPorHora()} mensajes por hora.`);
  }
  if (filas.length >= TOPES.maxPorDia()) {
    return frenar("limit_per_day", `Más de ${TOPES.maxPorDia()} mensajes en 24 h.`);
  }

  // 4b) Ráfaga: demasiados mensajes en una ventana corta. Es la regla
  //     del baneo: seis bloques seguidos en un minuto no son una
  //     conversación. Se cuenta por tiempo (no «desde la última
  //     respuesta») para dejar pasar una entrega pedida y repartida.
  const segundosRafaga = TOPES.ventanaRafagaSegundos();
  const enRafaga = filas.filter(
    (f) => new Date(f.created_at).getTime() >= ahora - segundosRafaga * 1000,
  ).length;
  if (enRafaga >= TOPES.maxEnRafaga()) {
    return frenar(
      "burst",
      `${enRafaga} mensajes en ${Math.round(segundosRafaga / 60)} minutos (tope ${TOPES.maxEnRafaga()}). Reparte el contenido entre turnos.`,
    );
  }

  // 5) El que más pesa: seguidos sin respuesta de la clienta.
  const corteEntrante = ultimoEntrante ? new Date(ultimoEntrante).getTime() : 0;
  const seguidos = filas.filter((f) => new Date(f.created_at).getTime() > corteEntrante).length;
  if (seguidos >= TOPES.maxSeguidos()) {
    return frenar(
      "too_many_consecutive",
      `${seguidos} mensajes seguidos sin que la clienta conteste (tope ${TOPES.maxSeguidos()}).`,
    );
  }

  // 6) Separación mínima.
  const ultimo = filas[0] ? new Date(filas[0].created_at).getTime() : null;
  if (ultimo && ahora - ultimo < TOPES.separacionMinimaSegundos() * 1000) {
    return frenar(
      "too_fast",
      `Menos de ${TOPES.separacionMinimaSegundos()} s desde el mensaje anterior.`,
    );
  }

  return { permitido: true, motivo: null };
}
