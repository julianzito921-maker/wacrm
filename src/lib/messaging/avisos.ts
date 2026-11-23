// ============================================================
// AVISOS A JULIÁN POR WHATSAPP — 19-nov-2026
//
// Meta exige que, si un bot atiende, exista una salida real a una
// persona. El CRM ya detecta «quiero hablar con una persona» y apaga la
// automatización en esa conversación; esto hace que ALGUIEN se entere:
// le escribe a Julián a su WhatsApp personal.
//
// Dos avisos:
//   1. Al momento: una clienta pidió hablar con una persona.
//   2. Cada vez que corre el cron de mensajería: resumen de problemas
//      del embudo (envíos que Meta rechazó, mensajes que la capa de
//      seguridad frenó, automatizaciones y flujos que fallaron, alertas
//      críticas como número baneado o nombre rechazado).
//
// Cómo sale: desde el número de WhatsApp Business de la cuenta.
//   - Con ALERTA_PLANTILLA (plantilla de utilidad aprobada, un parámetro
//     {{1}}) llega SIEMPRE.
//   - Sin plantilla sale como texto libre, que Meta solo entrega si Julián
//     le escribió a ese número en las últimas 24 h.
//
// Variables:
//   ALERTA_WHATSAPP   número de Julián (10 dígitos o con 52). Sin él, no hace nada.
//   ALERTA_PLANTILLA  nombre de la plantilla (opcional); ALERTA_IDIOMA (es_MX).
//   ALERTA_CUENTA_ID  cuenta cuyo número manda el aviso (por defecto, la
//                     primera conectada).
//   APP_URL           para el enlace al CRM.
//
// Nunca lanza: un aviso que falla no puede tumbar el webhook ni el cron.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { loadAccountMetaCredentials } from "@/lib/flows/meta-send";
import { enviarPlantilla, enviarTexto } from "./send";

const URL_CRM_POR_DEFECTO = "https://wacrm-production-e3cd4a64.up.railway.app";
const NO_REPETIR_MS = 30 * 60_000;
const ultimos = new Map<string, number>();

/** 5620714773 → 525620714773 (México). Deja igual lo que ya trae lada. */
export function numeroAviso(crudo: string | undefined | null): string | null {
  const d = (crudo ?? "").replace(/\D/g, "");
  if (d.length === 10) return `52${d}`;
  if (d.length === 13 && d.startsWith("521")) return `52${d.slice(3)}`;
  return d.length >= 11 ? d : null;
}

/** Meta no acepta saltos de línea ni más de 4 espacios seguidos en un parámetro de plantilla. */
export function textoParaPlantilla(texto: string): string {
  return texto
    .replace(/\s*\n+\s*/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 900);
}

export interface ResumenProblemas {
  rechazadosMeta: Record<string, number>;
  frenados: Record<string, number>;
  automatizacionesFallidas: number;
  flujosFallidos: number;
  alertasCriticas: string[];
}

/** Normales del día a día: no son problema del embudo. */
const FRENOS_NORMALES = new Set(["opt_out", "state_blocked", "automation_disabled"]);

export function hayProblemas(r: ResumenProblemas): boolean {
  const frenados = Object.entries(r.frenados).filter(([k]) => !FRENOS_NORMALES.has(k));
  return (
    Object.keys(r.rechazadosMeta).length > 0 ||
    frenados.length > 0 ||
    r.automatizacionesFallidas > 0 ||
    r.flujosFallidos > 0 ||
    r.alertasCriticas.length > 0
  );
}

export function textoResumen(r: ResumenProblemas): string {
  const partes: string[] = ["⚠️ Revisión del CRM"];
  const lista = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} (${n})`)
      .join(", ");
  if (r.alertasCriticas.length) partes.push(`Alertas: ${[...new Set(r.alertasCriticas)].join(", ")}`);
  if (Object.keys(r.rechazadosMeta).length) partes.push(`Meta rechazó envíos: ${lista(r.rechazadosMeta)}`);
  const frenados = Object.fromEntries(
    Object.entries(r.frenados).filter(([k]) => !FRENOS_NORMALES.has(k)),
  );
  if (Object.keys(frenados).length) partes.push(`Mensajes frenados por seguridad: ${lista(frenados)}`);
  if (r.automatizacionesFallidas) partes.push(`Automatizaciones con error: ${r.automatizacionesFallidas}`);
  if (r.flujosFallidos) partes.push(`Embudos con error: ${r.flujosFallidos}`);
  partes.push(`Detalle en el CRM: ${urlCrm()}`);
  return partes.join("\n");
}

function urlCrm(ruta = ""): string {
  return `${(process.env.APP_URL || URL_CRM_POR_DEFECTO).replace(/\/$/, "")}${ruta}`;
}

async function cuentaQueAvisa(db: ReturnType<typeof supabaseAdmin>): Promise<string | null> {
  if (process.env.ALERTA_CUENTA_ID) return process.env.ALERTA_CUENTA_ID;
  const { data } = await db
    .from("whatsapp_config")
    .select("account_id")
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1);
  return (data as Array<{ account_id: string }> | null)?.[0]?.account_id ?? null;
}

/** Manda un aviso a Julián. `clave` evita repetir el mismo aviso en 30 min. */
export async function avisarAJulian(texto: string, clave?: string): Promise<boolean> {
  const destino = numeroAviso(process.env.ALERTA_WHATSAPP);
  if (!destino) return false;
  if (clave) {
    const antes = ultimos.get(clave);
    if (antes && Date.now() - antes < NO_REPETIR_MS) return false;
    ultimos.set(clave, Date.now());
  }
  const db = supabaseAdmin();
  let ok = false;
  let error: string | null = null;
  let cuenta: string | null = null;
  try {
    cuenta = await cuentaQueAvisa(db);
    if (!cuenta) throw new Error("no hay ningún número de WhatsApp conectado para mandar el aviso");
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(db, cuenta);
    const ctx = { accountId: cuenta, source: "sistema" as const, reason: "aviso a Julián" };
    const plantilla = process.env.ALERTA_PLANTILLA;
    if (plantilla) {
      await enviarPlantilla({
        ctx,
        phoneNumberId,
        accessToken,
        to: destino,
        templateName: plantilla,
        language: process.env.ALERTA_IDIOMA || "es_MX",
        params: [textoParaPlantilla(texto)],
      });
    } else {
      await enviarTexto({ ctx, phoneNumberId, accessToken, to: destino, text: texto.slice(0, 3500) });
    }
    ok = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[avisos] no se pudo avisar a Julián:", error);
  }
  try {
    await db.from("messaging_alerts").insert({
      account_id: cuenta,
      regla: "aviso_whatsapp",
      severidad: ok ? "info" : "warning",
      detalle: { texto: texto.slice(0, 1000), ok, error } as never,
      accion: ok ? "avisado" : "aviso_fallido",
    });
  } catch {
    // el registro es secundario
  }
  return ok;
}

/** Una clienta pidió hablar con una persona. */
export async function avisarTraspasoHumano(args: {
  accountId: string;
  contactId: string;
  conversationId: string;
  texto: string;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("contacts")
      .select("name, phone")
      .eq("id", args.contactId)
      .maybeSingle();
    const c = (data as { name?: string | null; phone?: string | null } | null) ?? {};
    const quien = [c.name, c.phone ? `+${String(c.phone).replace(/^\+/, "")}` : null]
      .filter(Boolean)
      .join(" ");
    const dijo = args.texto.trim().slice(0, 200);
    await avisarAJulian(
      `🙋 Una clienta pidió hablar con una persona: ${quien || "sin nombre"}.\nDijo: «${dijo}».\nLa IA ya no le contesta en ese chat: entra al CRM y atiéndela. ${urlCrm("/inbox")}`,
      `humano:${args.conversationId}`,
    );
  } catch (err) {
    console.error("[avisos] traspaso:", err instanceof Error ? err.message : err);
  }
}

/**
 * Junta los problemas del embudo desde el último resumen y, si hay
 * alguno, se lo manda a Julián. Lo llama el cron de mensajería.
 */
export async function avisarProblemasDelEmbudo(): Promise<ResumenProblemas | null> {
  if (!numeroAviso(process.env.ALERTA_WHATSAPP)) return null;
  try {
    const db = supabaseAdmin();
    const { data: ultimo } = await db
      .from("messaging_alerts")
      .select("created_at")
      .eq("regla", "aviso_resumen")
      .order("created_at", { ascending: false })
      .limit(1);
    const tope = Date.now() - 24 * 3_600_000;
    const previo = (ultimo as Array<{ created_at: string }> | null)?.[0]?.created_at;
    const desde = new Date(Math.max(tope, previo ? new Date(previo).getTime() : Date.now() - 15 * 60_000)).toISOString();

    const [envios, autos, flujos, alertas] = await Promise.all([
      db
        .from("outbound_message_log")
        .select("status, error_code, blocked_reason, source")
        .in("status", ["failed", "blocked"])
        .gte("created_at", desde)
        .limit(2000),
      db.from("automation_logs").select("id").eq("status", "failed").gte("created_at", desde).limit(500),
      db.from("flow_runs").select("id").eq("status", "failed").gte("ended_at", desde).limit(500),
      db
        .from("messaging_alerts")
        .select("regla")
        .eq("severidad", "critical")
        .gte("created_at", desde)
        .limit(200),
    ]);

    const r: ResumenProblemas = {
      rechazadosMeta: {},
      frenados: {},
      automatizacionesFallidas: ((autos.data as unknown[] | null) ?? []).length,
      flujosFallidos: ((flujos.data as unknown[] | null) ?? []).length,
      alertasCriticas: ((alertas.data as Array<{ regla: string }> | null) ?? [])
        .map((a) => a.regla)
        .filter((x) => !x.startsWith("aviso_")),
    };
    for (const e of (envios.data as Array<{
      status: string;
      error_code: string | null;
      blocked_reason: string | null;
      source: string | null;
    }> | null) ?? []) {
      if (e.source === "sistema") continue; // los propios avisos no cuentan
      if (e.status === "failed") {
        const k = e.error_code ? `error ${e.error_code}` : "error sin código";
        r.rechazadosMeta[k] = (r.rechazadosMeta[k] ?? 0) + 1;
      } else if (e.blocked_reason) {
        r.frenados[e.blocked_reason] = (r.frenados[e.blocked_reason] ?? 0) + 1;
      }
    }

    if (!hayProblemas(r)) return r;
    // Solo se marca como avisado si de verdad salió: si falla, el próximo
    // cron lo vuelve a intentar con lo acumulado (máximo 24 h).
    if (!(await avisarAJulian(textoResumen(r)))) return r;
    await db.from("messaging_alerts").insert({
      account_id: null,
      regla: "aviso_resumen",
      severidad: "info",
      detalle: r as never,
      accion: "avisado",
    });
    return r;
  } catch (err) {
    console.error("[avisos] resumen:", err instanceof Error ? err.message : err);
    return null;
  }
}
