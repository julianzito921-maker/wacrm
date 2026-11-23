/**
 * Convierte un chat parseado en nodos de flujo, respetando el orden
 * cronológico y los tiempos reales.
 *
 * Mapeo:
 *   - Primer turno del cliente  → disparador (keyword con su texto).
 *   - Turnos siguientes         → `save_reply` (espera de respuesta).
 *   - Ráfaga del negocio        → `send_message` con burbujas en orden.
 *       · hueco ≤ 60 s          → `segundos` de la burbuja.
 *       · hueco > 60 s          → burbuja `interval`.
 *   - Hueco cliente→negocio     → nodo `wait` (reacción real).
 *   - Ráfagas separadas >30 min → dos bloques con un `wait` intermedio.
 *   - Fin del hilo              → nodo `end`.
 *
 * No sube medios ni toca la base de datos: recibe un mapa de URLs ya
 * subidas y devuelve los nodos + las incidencias para que el diálogo
 * decida si bloquea o continúa.
 */

import type {
  ChatMediaKind,
  ParsedChat,
  ParsedChatMessage,
} from "./whatsapp-chat-parser";
import { WAIT_MAX_SEGUNDOS, type BurbujaMensaje } from "./types";

/** Separación máxima dentro de una misma ráfaga del negocio. */
export const RAFAGA_MAX_SEGUNDOS = 30 * 60;
/** Tope de una espera dentro del motor (23 h, ventana de WhatsApp). */
export const ESPERA_MAX = WAIT_MAX_SEGUNDOS;
/** Tope del ritmo entre burbujas. */
const BURBUJA_MAX_SEGUNDOS = 60;

export type ChatFlowNodeType =
  | "start"
  | "send_message"
  | "wait"
  | "save_reply"
  | "end";

export interface ChatFlowNode {
  node_key: string;
  node_type: ChatFlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

export type BuildIssueCode =
  | "media_missing"
  | "omitted_media"
  | "unsupported_message"
  | "delay_capped"
  | "business_first"
  | "caption_split"
  | "first_message_media"
  | "empty_block"
  | "no_customer_messages"
  | "no_business_messages";

export interface BuildIssue {
  code: BuildIssueCode;
  blocking: boolean;
  detail?: string;
  messageIndex?: number;
  seconds?: number;
}

export interface BuildStats {
  turnosCliente: number;
  bloques: number;
  burbujas: number;
  esperas: number;
  medios: number;
}

export interface BuiltChatFlow {
  nodes: ChatFlowNode[];
  issues: BuildIssue[];
  stats: BuildStats;
  trigger_type: "keyword" | "any_message";
  trigger_config: Record<string, unknown>;
}

export interface BuildChatFlowOptions {
  chat: ParsedChat;
  /** Nombre exacto del participante que somos nosotros. */
  businessName: string;
  /** nombre de archivo en minúsculas → URL pública subida. */
  mediaUrls: Map<string, string>;
  trigger?: "keyword" | "any_message";
}

type Paso =
  | { tipo: "wait"; segundos: number }
  | { tipo: "save_reply" }
  | { tipo: "bloque"; mensajes: ParsedChatMessage[] };

function esNegocio(m: ParsedChatMessage, negocio: string): boolean {
  return m.author === negocio;
}

function segundosEntre(a: ParsedChatMessage, b: ParsedChatMessage): number {
  return Math.max(0, Math.round((b.at.getTime() - a.at.getTime()) / 1000));
}

function claveMedia(nombre: string): string {
  return nombre.trim().toLowerCase();
}

/** Ráfagas del negocio: un turno se parte si hay >30 min entre mensajes. */
function partirRafagas(
  turno: ParsedChatMessage[],
  negocio: string,
): Array<ParsedChatMessage[]> {
  const bloques: Array<ParsedChatMessage[]> = [];
  let actual: ParsedChatMessage[] = [];
  for (let i = 0; i < turno.length; i += 1) {
    const m = turno[i];
    const previo = turno[i - 1];
    if (previo && esNegocio(previo, negocio)) {
      const hueco = segundosEntre(previo, m);
      if (hueco > RAFAGA_MAX_SEGUNDOS) {
        if (actual.length) bloques.push(actual);
        actual = [];
      }
    }
    actual.push(m);
  }
  if (actual.length) bloques.push(actual);
  return bloques;
}

/** Construye la lista de pasos (esperas, turnos y bloques). */
function construirPasos(
  mensajes: ParsedChatMessage[],
  negocio: string,
  issues: BuildIssue[],
): { pasos: Paso[]; primerCliente: ParsedChatMessage | null } {
  // Turnos: mensajes consecutivos del mismo participante.
  const turnos: Array<{ rol: "negocio" | "cliente"; msgs: ParsedChatMessage[] }> = [];
  for (const m of mensajes) {
    const rol = esNegocio(m, negocio) ? "negocio" : "cliente";
    const ultimo = turnos[turnos.length - 1];
    if (ultimo && ultimo.rol === rol) ultimo.msgs.push(m);
    else turnos.push({ rol, msgs: [m] });
  }

  const primerCliente = mensajes.find((m) => !esNegocio(m, negocio)) ?? null;
  const huboNegocio = turnos.some((t) => t.rol === "negocio");
  if (mensajes.length > 0 && !primerCliente) {
    issues.push({ code: "no_customer_messages", blocking: true });
  }
  if (!huboNegocio) {
    issues.push({ code: "no_business_messages", blocking: true });
  }
  if (turnos[0]?.rol === "negocio") {
    // No se puede reproducir antes del disparador: va al inicio.
    issues.push({ code: "business_first", blocking: false });
  }

  const pasos: Paso[] = [];
  let anterior: ParsedChatMessage | null = null;
  let primerTurnoClienteVisto = false;

  for (const turno of turnos) {
    if (turno.rol === "cliente") {
      const esElPrimero = !primerTurnoClienteVisto;
      primerTurnoClienteVisto = true;
      anterior = turno.msgs[turno.msgs.length - 1];
      // El primer turno es el disparador: no se espera dos veces.
      if (!esElPrimero) pasos.push({ tipo: "save_reply" });
      continue;
    }

    // Negocio: puede haber varias ráfagas dentro del turno.
    const bloques = partirRafagas(turno.msgs, negocio);
    for (const bloque of bloques) {
      const primero = bloque[0];
      if (anterior) {
        const hueco = segundosEntre(anterior, primero);
        const anteriorNegocio = esNegocio(anterior, negocio);
        if (hueco > 0) {
          const capado = Math.min(hueco, ESPERA_MAX);
          if (hueco > ESPERA_MAX) {
            issues.push({
              code: "delay_capped",
              blocking: false,
              seconds: hueco,
              messageIndex: primero.index,
            });
          }
          // Tras el cliente es el tiempo de reacción; tras una pausa
          // larga del negocio, es la pausa de seguimiento. En ambos
          // casos se refleja con un wait real.
          if (!anteriorNegocio || capado > RAFAGA_MAX_SEGUNDOS) {
            pasos.push({ tipo: "wait", segundos: capado });
          }
        }
      }
      pasos.push({ tipo: "bloque", mensajes: bloque });
      anterior = bloque[bloque.length - 1];
    }
  }

  return { pasos, primerCliente };
}

export function buildChatFlow(opciones: BuildChatFlowOptions): BuiltChatFlow {
  const { chat, businessName, mediaUrls } = opciones;
  const issues: BuildIssue[] = [];

  const soportados: ParsedChatMessage[] = [];
  for (const m of chat.messages) {
    const delNegocio = esNegocio(m, businessName);
    // Lo que manda el cliente no se reproduce (solo marca el turno), así
    // que sus medios omitidos o eliminados no impiden clonar la parte
    // nuestra. Los del negocio sí: sin archivo no hay burbuja posible.
    if (m.unsupported) {
      if (delNegocio) {
        issues.push({
          code: "unsupported_message",
          blocking: true,
          detail: m.unsupported,
          messageIndex: m.index,
        });
        continue;
      }
      soportados.push(m);
      continue;
    }
    if (m.omitted) {
      if (delNegocio) {
        issues.push({
          code: "omitted_media",
          blocking: true,
          detail: m.text || undefined,
          messageIndex: m.index,
        });
        continue;
      }
      soportados.push(m);
      continue;
    }
    soportados.push(m);
  }

  const { pasos, primerCliente } = construirPasos(
    soportados,
    businessName,
    issues,
  );

  const nodos: ChatFlowNode[] = [];
  let y = 0;
  const crear = (
    node_type: ChatFlowNodeType,
    key: string,
    config: Record<string, unknown>,
  ): ChatFlowNode => {
    const nodo: ChatFlowNode = {
      node_key: key,
      node_type,
      config,
      position_x: 0,
      position_y: y,
    };
    nodos.push(nodo);
    y += 170;
    return nodo;
  };

  const start = crear("start", "start", { next_node_key: "" });
  let anteriorNodo: ChatFlowNode = start;
  const enlazar = (n: ChatFlowNode) => {
    if (anteriorNodo.node_type === "save_reply") {
      anteriorNodo.config.contesto_next = n.node_key;
    } else {
      anteriorNodo.config.next_node_key = n.node_key;
    }
    anteriorNodo = n;
  };

  const stats: BuildStats = {
    turnosCliente: 0,
    bloques: 0,
    burbujas: 0,
    esperas: 0,
    medios: 0,
  };
  let nPausa = 0;
  let nTurno = 0;
  let nBloque = 0;
  let primerNodoReal = "";

  for (const paso of pasos) {
    if (paso.tipo === "wait") {
      nPausa += 1;
      const nodo = crear("wait", `pausa_${nPausa}`, {
        segundos: paso.segundos,
        next_node_key: "",
      });
      if (!primerNodoReal) primerNodoReal = nodo.node_key;
      enlazar(nodo);
      stats.esperas += 1;
      continue;
    }

    if (paso.tipo === "save_reply") {
      nTurno += 1;
      const nodo = crear("save_reply", `espera_${nTurno}`, {
        prompt_text: "",
        var_key: `respuesta_${nTurno}`,
        espera_segundos: 86_400,
        espera_minutos: 1_440,
        esperar_indefinido: false,
        buffer_segundos: 0,
        citar_respuesta: false,
        reaccionar: false,
        campo_contacto: "",
        contesto_next: "",
        no_contesto_next: "fin",
      });
      if (!primerNodoReal) primerNodoReal = nodo.node_key;
      enlazar(nodo);
      stats.turnosCliente += 1;
      continue;
    }

    // Bloque del negocio.
    const items: BurbujaMensaje[] = [];
    let anteriorMsg: ParsedChatMessage | null = null;

    for (const m of paso.mensajes) {
      let hueco = anteriorMsg ? segundosEntre(anteriorMsg, m) : 0;
      anteriorMsg = m;
      if (hueco > ESPERA_MAX) {
        issues.push({
          code: "delay_capped",
          blocking: false,
          seconds: hueco,
          messageIndex: m.index,
        });
        hueco = ESPERA_MAX;
      }
      if (hueco > BURBUJA_MAX_SEGUNDOS) {
        items.push({ tipo: "interval", segundos: hueco });
        hueco = 0;
      }

      if (m.media) {
        const url = mediaUrls.get(claveMedia(m.media.filename));
        if (!url) {
          issues.push({
            code: "media_missing",
            blocking: true,
            detail: m.media.filename,
            messageIndex: m.index,
          });
          if (m.text.trim()) {
            items.push({ tipo: "text", text: m.text, segundos: hueco });
          }
          continue;
        }
        const tipo: ChatMediaKind = m.media.kind;
        const conPie =
          tipo === "image" || tipo === "video" || tipo === "document";
        items.push({
          tipo,
          media_url: url,
          text: conPie ? m.text : undefined,
          filename: tipo === "document" ? m.media.filename : undefined,
          segundos: hueco,
        });
        if (!conPie && m.text.trim()) {
          issues.push({
            code: "caption_split",
            blocking: false,
            detail: m.media.filename,
            messageIndex: m.index,
          });
          items.push({ tipo: "text", text: m.text, segundos: 0 });
        }
        stats.medios += 1;
      } else if (m.text.trim()) {
        items.push({ tipo: "text", text: m.text, segundos: hueco });
      }
    }

    if (items.length === 0) {
      issues.push({ code: "empty_block", blocking: false });
      continue;
    }

    nBloque += 1;
    const nodo = crear("send_message", `msg_${nBloque}`, {
      text: "",
      items,
      next_node_key: "",
    });
    if (!primerNodoReal) primerNodoReal = nodo.node_key;
    enlazar(nodo);
    stats.bloques += 1;
    stats.burbujas += items.filter((i) => i.tipo !== "interval").length;
  }

  const fin = crear("end", "fin", {});
  enlazar(fin);
  start.config.next_node_key = primerNodoReal || "fin";

  const textoTrigger = primerCliente?.text.trim() ?? "";
  const pedido = opciones.trigger ?? "keyword";
  let trigger_type: "keyword" | "any_message" = "keyword";
  let trigger_config: Record<string, unknown> = {
    keywords: [textoTrigger],
    match_type: "contains",
  };
  if (pedido === "any_message" || !textoTrigger) {
    trigger_type = "any_message";
    trigger_config = {};
    if (primerCliente?.media && !textoTrigger) {
      issues.push({ code: "first_message_media", blocking: false });
    }
  }

  return { nodes: nodos, issues, stats, trigger_type, trigger_config };
}

/** ¿Hay algo que impida importar sin marcar «ignorar incidencias»? */
export function tieneIncidenciasBloqueantes(issues: BuildIssue[]): boolean {
  return issues.some((i) => i.blocking);
}
