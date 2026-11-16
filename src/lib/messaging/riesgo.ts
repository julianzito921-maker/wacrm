// ============================================================
// MÉTRICAS DE RIESGO Y ALERTAS — Fase 6 (§21, §22)
//
// «¿Estamos hablando demasiado?» es la pregunta que precede a un
// baneo, y hasta hoy no se podía contestar. Aquí se calcula con lo que
// ya está registrado (outbound_message_log + messages) y se decide si
// hay que avisar, pausar un flujo o apagar la automatización entera.
//
// Nada de esto inventa datos: todo sale del registro de la fase 1.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { fijarInterruptor } from "./interruptor";

export interface MetricasRiesgo {
  ventanaHoras: number;
  enviados: number;
  frenados: number;
  fallidos: number;
  duplicados: number;
  seguidosMax: number;
  conversacionesConMasDe6: number;
  porHoraMax: number;
  porFlujo: Array<{ workflowId: string | null; nodo: string | null; enviados: number }>;
  /** La métrica que más pesa: cuánto habla el CRM por cada mensaje del
   *  cliente. Por encima de 3 ya es una conversación desequilibrada. */
  outboundPorUsuario: number;
}

const UMBRAL = {
  ratioAlto: () => Number(process.env.ALERT_RATIO_ALTO ?? 5),
  enviosPorConversacion: () => Number(process.env.ALERT_ENVIOS_POR_CONVERSACION ?? 10),
  seguidos: () => Number(process.env.ALERT_SEGUIDOS ?? 8),
  errores: () => Number(process.env.ALERT_ERRORES ?? 20),
};

interface FilaLog {
  conversation_id: string | null;
  created_at: string;
  status: string;
  workflow_id: string | null;
  workflow_node_key: string | null;
}

export async function metricasDeRiesgo(
  accountId: string,
  horas = 24,
): Promise<MetricasRiesgo> {
  const db = supabaseAdmin();
  const desde = new Date(Date.now() - horas * 3_600_000).toISOString();

  const [log, entrantes] = await Promise.all([
    db
      .from("outbound_message_log")
      .select("conversation_id, created_at, status, workflow_id, workflow_node_key")
      .eq("account_id", accountId)
      .gte("created_at", desde)
      .limit(5000),
    db
      .from("messages")
      .select("conversation_id")
      .eq("sender_type", "customer")
      .gte("created_at", desde)
      .limit(5000),
  ]);

  const filas = (log.data as FilaLog[] | null) ?? [];
  const porConv = new Map<string, FilaLog[]>();
  const porHora = new Map<string, number>();
  const porFlujo = new Map<string, { workflowId: string | null; nodo: string | null; enviados: number }>();

  for (const f of filas) {
    if (f.conversation_id) {
      porConv.set(f.conversation_id, [...(porConv.get(f.conversation_id) ?? []), f]);
    }
    const hora = f.created_at.slice(0, 13);
    porHora.set(hora, (porHora.get(hora) ?? 0) + 1);
    const clave = `${f.workflow_id ?? "-"}:${f.workflow_node_key ?? "-"}`;
    const actual = porFlujo.get(clave) ?? {
      workflowId: f.workflow_id,
      nodo: f.workflow_node_key,
      enviados: 0,
    };
    actual.enviados += 1;
    porFlujo.set(clave, actual);
  }

  let seguidosMax = 0;
  let conversacionesConMasDe6 = 0;
  for (const lista of porConv.values()) {
    const ordenadas = [...lista].sort((a, b) => a.created_at.localeCompare(b.created_at));
    let seguidos = 0;
    let max = 0;
    for (const f of ordenadas) {
      seguidos = f.status === "sent" ? seguidos + 1 : 0;
      max = Math.max(max, seguidos);
    }
    seguidosMax = Math.max(seguidosMax, max);
    if (max > 6) conversacionesConMasDe6 += 1;
  }

  const enviados = filas.filter((f) => f.status === "sent").length;
  const entrantesTotal = ((entrantes.data as unknown[] | null) ?? []).length;

  return {
    ventanaHoras: horas,
    enviados,
    frenados: filas.filter((f) => f.status === "blocked").length,
    fallidos: filas.filter((f) => f.status === "failed").length,
    duplicados: filas.filter((f) => f.status === "blocked").length,
    seguidosMax,
    conversacionesConMasDe6,
    porHoraMax: Math.max(0, ...porHora.values()),
    porFlujo: [...porFlujo.values()].sort((a, b) => b.enviados - a.enviados).slice(0, 10),
    outboundPorUsuario:
      entrantesTotal > 0 ? Number((enviados / entrantesTotal).toFixed(2)) : enviados,
  };
}

export interface Alerta {
  regla: string;
  severidad: "info" | "warning" | "critical";
  detalle: Record<string, unknown>;
  accion: string;
}

/**
 * Revisa las métricas y, si algo se desboca, actúa:
 *   - una conversación con demasiados mensajes seguidos → avisa;
 *   - un flujo que manda mucho más que el resto → se pausa solo;
 *   - demasiados errores de API → avisa;
 *   - la relación outbound/usuario muy alta → avisa (y apaga si es crítico).
 */
export async function evaluarAlertas(accountId: string): Promise<Alerta[]> {
  const m = await metricasDeRiesgo(accountId);
  const alertas: Alerta[] = [];
  const db = supabaseAdmin();

  if (m.seguidosMax >= UMBRAL.seguidos()) {
    alertas.push({
      regla: "racha_seguida",
      severidad: "warning",
      detalle: { seguidosMax: m.seguidosMax, conversacionesConMasDe6: m.conversacionesConMasDe6 },
      accion: "avisar",
    });
  }

  if (m.outboundPorUsuario >= UMBRAL.ratioAlto()) {
    alertas.push({
      regla: "outbound_por_usuario",
      severidad: m.outboundPorUsuario >= UMBRAL.ratioAlto() * 2 ? "critical" : "warning",
      detalle: { ratio: m.outboundPorUsuario, enviados: m.enviados },
      accion: "avisar",
    });
  }

  if (m.fallidos >= UMBRAL.errores()) {
    alertas.push({
      regla: "errores_api",
      severidad: "warning",
      detalle: { fallidos: m.fallidos },
      accion: "avisar",
    });
  }

  // El flujo que más manda: si uno solo concentra la mayoría del volumen,
  // se pausa (es el que puede estar en bucle).
  const totalFlujo = m.porFlujo.reduce((s, f) => s + f.enviados, 0);
  const top = m.porFlujo[0];
  if (top?.workflowId && totalFlujo >= 20 && top.enviados / totalFlujo >= 0.8) {
    try {
      await db
        .from("flows")
        .update({
          status: "draft",
          auto_paused_at: new Date().toISOString(),
          auto_pause_reason: `Envió ${top.enviados} de ${totalFlujo} mensajes en ${m.ventanaHoras} h`,
        })
        .eq("id", top.workflowId)
        .eq("account_id", accountId);
      alertas.push({
        regla: "flujo_desbocado",
        severidad: "critical",
        detalle: { workflowId: top.workflowId, enviados: top.enviados, total: totalFlujo },
        accion: "flujo_pausado",
      });
    } catch (err) {
      console.error("[riesgo] no se pudo pausar el flujo:", err);
    }
  }

  // Crítico de verdad: se apaga la automatización entera (§23).
  if (m.outboundPorUsuario >= UMBRAL.ratioAlto() * 3 || m.seguidosMax >= UMBRAL.seguidos() * 3) {
    await fijarInterruptor(
      false,
      `Auto-pausa: ratio ${m.outboundPorUsuario}, racha máxima ${m.seguidosMax}`,
    );
    alertas.push({
      regla: "apagado_automatico",
      severidad: "critical",
      detalle: { ratio: m.outboundPorUsuario, seguidosMax: m.seguidosMax },
      accion: "automatizacion_apagada",
    });
  }

  if (alertas.length > 0) {
    try {
      await db.from("messaging_alerts").insert(
        alertas.map((a) => ({
          account_id: accountId,
          regla: a.regla,
          severidad: a.severidad,
          detalle: a.detalle as never,
          accion: a.accion,
        })),
      );
    } catch (err) {
      console.error("[riesgo] no se pudieron registrar las alertas:", err);
    }
  }

  return alertas;
}
