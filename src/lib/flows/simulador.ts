/**
 * Simulador del embudo para la vista previa del editor («celular de
 * prueba»).
 *
 * Recorre el flujo que está en el editor (aunque no esté guardado ni
 * activo) igual que lo haría el motor (`engine.ts`) con una clienta
 * real, pero sin tocar nada: no manda a Meta, no escribe en la base, no
 * dispara CAPI, ventas, etiquetas ni notificaciones. Esos pasos se
 * anuncian en la conversación como «efecto» para que se vea que
 * ocurrirían.
 *
 * Fidelidad: las decisiones salen del MISMO código que el motor
 * (`respuestas.ts`, `fallback.ts`, `bloques-avanzados.ts`, `agenda.ts`,
 * `pago-textos.ts`, `fichas.ts`). Lo que necesita servidor (bloque de
 * IA, integración HTTP, flujo conectado) llega por `SimServicios`, que
 * la vista conecta a rutas que tampoco envían nada.
 *
 * Las esperas largas (Smart Delay, «no contesta», pagos, carrusel,
 * permiso de llamada) no se esperan: la corrida queda estacionada y el
 * probador elige qué pasa («Adelantar», «No contesta», «Pago
 * aprobado»…). Así se prueba cada rama en segundos.
 *
 * Puro y sin dependencias de servidor: corre en el navegador.
 */

import { esperaProgramadaSegundos } from "./agenda";
import {
  combinarCondiciones,
  destinoBloqueIa,
  puedeTransferir,
  reglasDeCondicion,
} from "./bloques-avanzados";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { parametrosDePlantilla, sustituirFichas, type DatosFichas } from "./fichas";
import {
  BOTONES_PAGO,
  TEXTO_NO_ES_COMPROBANTE,
  TEXTO_PIDE_COMPROBANTE,
  combinarDatosPago,
  textoPagoSpei,
} from "./pago-textos";
import {
  evaluateConditionPredicate,
  interpolateVars,
  matchReplyId,
  matchesKeywordTrigger,
  matchTypedReply,
} from "./respuestas";
import {
  BUFFER_MAX_SEGUNDOS,
  BURBUJA_ESCRIBIENDO_DEFECTO,
  BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS,
  ESPERA_MAX_SEGUNDOS,
  MAX_NODES_PER_ADVANCE,
  NODOS_FIN_DE_RAMA,
  WAIT_INLINE_MAX_SEGUNDOS,
  WAIT_MAX_SEGUNDOS,
  WAIT_PROGRAMADO_MAX_SEGUNDOS,
  type AiBlockNodeConfig,
  type BurbujaMensaje,
  type CarouselNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type ConnectFlowNodeConfig,
  type DistributorNodeConfig,
  type HandoffNodeConfig,
  type HttpRequestNodeConfig,
  type KeywordTriggerConfig,
  type ManipulatorNodeConfig,
  type OfficialCallNodeConfig,
  type PaymentGatewayNodeConfig,
  type SaveReplyNodeConfig,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SendPaymentNodeConfig,
  type SendTemplateNodeConfig,
  type SetTagNodeConfig,
  type WaitNodeConfig,
} from "./types";

// ============================================================
// Tipos
// ============================================================

export interface SimNodo {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface SimFlujo {
  id: string;
  name?: string;
  trigger_type: "keyword" | "first_inbound_message" | "any_message" | "manual";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: unknown;
  nodes: SimNodo[];
}

export interface SimContacto {
  name: string;
  phone: string;
  email: string;
  company: string;
}

/** Turno de la conversación, para dar contexto a la IA. */
export interface SimTurno {
  rol: "cliente" | "negocio";
  texto: string;
}

export type SimMedio = "image" | "video" | "audio" | "document" | "sticker";

/** Lo que aparece en el celular (o en la línea de tiempo del probador). */
export type SimSalida =
  | { tipo: "texto"; nodo: string; texto: string; escribiendo: number; cita?: string }
  | {
      tipo: "medio";
      nodo: string;
      medio: SimMedio;
      url: string;
      pie?: string;
      archivo?: string;
      escribiendo: number;
    }
  | {
      tipo: "botones";
      nodo: string;
      texto: string;
      encabezado?: string;
      pie?: string;
      imagen?: string;
      botones: Array<{ id: string; titulo: string }>;
      escribiendo: number;
    }
  | {
      tipo: "lista";
      nodo: string;
      texto: string;
      encabezado?: string;
      pie?: string;
      boton: string;
      secciones: Array<{
        titulo?: string;
        filas: Array<{ id: string; titulo: string; descripcion?: string }>;
      }>;
      escribiendo: number;
    }
  | {
      tipo: "plantilla";
      nodo: string;
      nombre: string;
      idioma: string;
      parametros: string[];
      escribiendo: number;
    }
  | { tipo: "permiso_llamada"; nodo: string; texto: string }
  | { tipo: "reaccion"; nodo: string; emoji: string }
  | { tipo: "pausa"; nodo: string; segundos: number }
  /** Paso sin mensaje que en producción tendría un efecto (etiqueta, CAPI…). */
  | { tipo: "efecto"; nodo: string; node_type: string; detalle?: string }
  /** Aviso del simulador: inicio, fin, fallback, esperas, errores. */
  | { tipo: "evento"; codigo: SimCodigo; nodo?: string; datos?: Record<string, string | number> };

export type SimCodigo =
  | "inicio"
  | "no_dispara"
  | "fin_nodo_end"
  | "fin_de_rama"
  | "fin_handoff"
  | "fin_error"
  | "fin_transferido"
  | "espera_tiempo"
  | "espera_respuesta"
  | "espera_comprobante"
  | "espera_pago"
  | "espera_permiso"
  | "espera_carrusel"
  | "buffer_abierto"
  | "mensaje_en_espera"
  | "fallback_repregunta"
  | "fallback_ignora"
  | "fallback_agotado_humano"
  | "fallback_agotado_fin"
  | "condicion"
  | "ia_bloque"
  | "ia_bloque_sin_servicio"
  | "http_simulado"
  | "http_real"
  | "variable_guardada"
  | "fuera_de_ventana"
  | "pago_aprobado"
  | "pago_rechazado"
  | "no_es_comprobante"
  | "no_contesto"
  | "permiso_aceptado"
  | "permiso_rechazado"
  | "transferido";

export type SimEspera =
  | { tipo: "respuesta"; nodo: string; tiempo?: number; indefinido?: boolean }
  | { tipo: "buffer"; nodo: string; segundos: number; textos: string[] }
  | { tipo: "tiempo"; nodo: string; segundos: number; burbuja?: number }
  | { tipo: "comprobante"; nodo: string }
  | { tipo: "pago"; nodo: string; proveedor: string }
  | { tipo: "permiso"; nodo: string }
  | { tipo: "carrusel"; nodo: string };

export interface SimEstado {
  fase: "sin_iniciar" | "activa" | "terminada";
  /** Flujo en curso (cambia con «Conectar flujo»). */
  flujoId: string;
  actual: string | null;
  espera: SimEspera | null;
  vars: Record<string, unknown>;
  etiquetas: string[];
  contacto: SimContacto;
  reprompts: number;
  cadena: string[];
  distribuidor: Record<string, number>;
  /** Cómo terminó la última corrida. */
  fin: null | { estado: "completed" | "handed_off" | "failed"; motivo: string };
  /** Tras un traspaso con «pausar IA», en producción nadie contesta. */
  iaPausada: boolean;
  /** Nodos por los que pasó, en orden (para resaltar en el editor). */
  recorrido: string[];
  /** La clienta ya escribió antes (el disparador «primer mensaje» no vuelve). */
  yaEscribio: boolean;
  /** El flujo «cualquier mensaje» ya corrió (enfriamiento de 24 h). */
  yaCorrio: boolean;
  historial: SimTurno[];
}

export type SimEntrada =
  | { kind: "text"; text: string }
  | { kind: "tap"; reply_id: string; title: string }
  | {
      kind: "media";
      media_type: "image" | "document";
      caption: string;
      /** Qué «leería» la IA en el archivo. */
      comprobante: "valido" | "invalido" | "no";
    };

/** Lo que el probador puede forzar mientras la corrida espera. */
export type SimAccion =
  | "adelantar"
  | "no_contesta"
  | "pago_aprobado"
  | "pago_rechazado"
  | "permiso_aceptado"
  | "permiso_rechazado"
  | "fuera_de_ventana";

export interface SimServicios {
  iaBloque?: (args: {
    flujoId: string;
    nodo: SimNodo;
    historial: SimTurno[];
    vars: Record<string, unknown>;
  }) => Promise<{ respuesta: string; salida: string | null } | null>;
  http?: (args: {
    cfg: HttpRequestNodeConfig;
    vars: Record<string, unknown>;
  }) => Promise<{ ok: boolean; status: number; mapped: Record<string, unknown> } | null>;
  cargarFlujo?: (id: string) => Promise<SimFlujo | null>;
}

export interface SimResultado {
  estado: SimEstado;
  salidas: SimSalida[];
  /**
   * false = el flujo no tomó el mensaje: en producción lo contesta la IA
   * (o una automatización). La vista decide si pide esa respuesta.
   */
  consumido: boolean;
}

// ============================================================
// Estado inicial
// ============================================================

export function estadoInicial(
  flujoId: string,
  contacto: Partial<SimContacto> = {},
): SimEstado {
  return {
    fase: "sin_iniciar",
    flujoId,
    actual: null,
    espera: null,
    vars: {},
    etiquetas: [],
    contacto: {
      name: contacto.name ?? "Clienta de prueba",
      phone: contacto.phone ?? "5215500000000",
      email: contacto.email ?? "",
      company: contacto.company ?? "",
    },
    reprompts: 0,
    cadena: [],
    distribuidor: {},
    fin: null,
    iaPausada: false,
    recorrido: [],
    yaEscribio: false,
    yaCorrio: false,
    historial: [],
  };
}

/** Copia profunda barata (el estado es JSON). */
function clonar(e: SimEstado): SimEstado {
  return JSON.parse(JSON.stringify(e)) as SimEstado;
}

// ============================================================
// Contexto de un paso
// ============================================================

interface Ctx {
  estado: SimEstado;
  flujo: SimFlujo;
  nodos: Map<string, SimNodo>;
  salidas: SimSalida[];
  servicios: SimServicios;
  /** Último mensaje de la clienta, para el bloque de IA. */
  citaPendiente: string | null;
}

function crearCtx(
  estado: SimEstado,
  flujo: SimFlujo,
  servicios: SimServicios,
): Ctx {
  return {
    estado,
    flujo,
    nodos: new Map(flujo.nodes.map((n) => [n.node_key, n])),
    salidas: [],
    servicios,
    citaPendiente: null,
  };
}

function iv(ctx: Ctx, texto: string | undefined | null): string {
  return interpolateVars(texto ?? "", ctx.estado.vars);
}

function ivOpt(ctx: Ctx, texto: string | undefined | null): string | undefined {
  return texto === undefined || texto === null || texto === "" ? undefined : iv(ctx, texto);
}

function datosFichas(ctx: Ctx): DatosFichas {
  return {
    contacto: { ...ctx.estado.contacto },
    personalizados: Object.fromEntries(
      Object.entries(ctx.estado.vars)
        .filter(([k]) => k.startsWith("custom:"))
        .map(([k, v]) => [k.slice(7), String(v)]),
    ),
    vars: ctx.estado.vars,
  };
}

/** Segundos de «escribiendo…» del motor (sin la variación aleatoria). */
export function segundosEscribiendo(texto: string): number {
  const ms = Math.min(Math.max(2_500 + texto.length * 65, 2_500), 12_000);
  return Math.round(ms / 100) / 10;
}

function negocioDice(ctx: Ctx, texto: string): void {
  if (texto.trim()) ctx.estado.historial.push({ rol: "negocio", texto });
}

function emitirTexto(ctx: Ctx, nodo: string, texto: string, escribiendo?: number): void {
  const cita = ctx.citaPendiente ?? undefined;
  ctx.citaPendiente = null;
  ctx.salidas.push({
    tipo: "texto",
    nodo,
    texto,
    escribiendo: escribiendo ?? segundosEscribiendo(texto),
    ...(cita ? { cita } : {}),
  });
  negocioDice(ctx, texto);
}

function evento(
  ctx: Ctx,
  codigo: SimCodigo,
  nodo?: string,
  datos?: Record<string, string | number>,
): void {
  ctx.salidas.push({ tipo: "evento", codigo, ...(nodo ? { nodo } : {}), ...(datos ? { datos } : {}) });
}

function terminar(
  ctx: Ctx,
  estado: "completed" | "handed_off" | "failed",
  motivo: string,
  codigo: SimCodigo,
  nodo?: string,
): void {
  ctx.estado.fase = "terminada";
  ctx.estado.actual = null;
  ctx.estado.espera = null;
  ctx.estado.fin = { estado, motivo };
  ctx.estado.reprompts = 0;
  evento(ctx, codigo, nodo, { motivo });
}

function estacionar(ctx: Ctx, nodo: string, espera: SimEspera): void {
  ctx.estado.actual = nodo;
  ctx.estado.espera = espera;
}

// ============================================================
// Avance (espejo de advanceFromNodeKey)
// ============================================================

async function avanzar(ctx: Ctx, desde: string | null | undefined): Promise<void> {
  let actual: string | null = desde ?? null;
  let anterior: SimNodo | null = null;
  ctx.estado.espera = null;

  for (let vuelta = 0; vuelta < MAX_NODES_PER_ADVANCE; vuelta += 1) {
    if (!actual && anterior && NODOS_FIN_DE_RAMA.has(anterior.node_type)) {
      terminar(ctx, "completed", "fin_de_rama", "fin_de_rama", anterior.node_key);
      return;
    }
    if (!actual) {
      terminar(ctx, "failed", "missing_next_node", "fin_error", anterior?.node_key);
      return;
    }
    const nodo = ctx.nodos.get(actual);
    if (!nodo) {
      terminar(ctx, "failed", "node_not_found", "fin_error", actual);
      return;
    }
    anterior = nodo;
    ctx.estado.actual = nodo.node_key;
    ctx.estado.recorrido.push(nodo.node_key);
    const cfg = nodo.config;
    const k = nodo.node_key;

    switch (nodo.node_type) {
      case "start":
        actual = (cfg.next_node_key as string) ?? null;
        continue;

      case "send_message": {
        const c = cfg as unknown as SendMessageNodeConfig;
        if (Array.isArray(c.items) && c.items.length > 0) {
          const r = burbujas(ctx, nodo, 0, false);
          if (r === "estacionada") return;
          actual = c.next_node_key;
          continue;
        }
        emitirTexto(ctx, k, iv(ctx, c.text));
        actual = c.next_node_key;
        continue;
      }

      case "send_media": {
        const c = cfg as unknown as SendMediaNodeConfig;
        const pie = ivOpt(ctx, c.caption);
        ctx.citaPendiente = null;
        ctx.salidas.push({
          tipo: "medio",
          nodo: k,
          medio: c.media_type,
          url: iv(ctx, c.media_url),
          ...(pie ? { pie } : {}),
          ...(c.filename ? { archivo: c.filename } : {}),
          escribiendo: segundosEscribiendo(c.caption ?? ""),
        });
        negocioDice(ctx, pie ?? `[${c.media_type}]`);
        actual = c.next_node_key;
        continue;
      }

      case "wait": {
        const c = cfg as unknown as WaitNodeConfig;
        const segundos = segundosDeEspera(c);
        if (segundos === null) {
          terminar(ctx, "failed", "wait_schedule_invalid", "fin_error", k);
          return;
        }
        if (segundos > WAIT_INLINE_MAX_SEGUNDOS) {
          estacionar(ctx, k, { tipo: "tiempo", nodo: k, segundos });
          evento(ctx, "espera_tiempo", k, { segundos });
          return;
        }
        if (segundos > 0) ctx.salidas.push({ tipo: "pausa", nodo: k, segundos });
        actual = c.next_node_key;
        continue;
      }

      case "condition": {
        const c = cfg as unknown as ConditionNodeConfig;
        const ok = evaluarCondicion(ctx, c);
        evento(ctx, "condicion", k, { resultado: ok ? "true" : "false" });
        actual = ok ? c.true_next : c.false_next;
        continue;
      }

      case "set_tag": {
        const c = cfg as unknown as SetTagNodeConfig;
        const ids = c.tag_ids?.length ? c.tag_ids : c.tag_id ? [c.tag_id] : [];
        for (const id of ids) {
          if (c.mode === "add") {
            if (!ctx.estado.etiquetas.includes(id)) ctx.estado.etiquetas.push(id);
          } else {
            ctx.estado.etiquetas = ctx.estado.etiquetas.filter((t) => t !== id);
          }
        }
        ctx.salidas.push({ tipo: "efecto", nodo: k, node_type: nodo.node_type });
        actual = c.next_node_key;
        continue;
      }

      case "meta_capi":
      case "move_kanban":
      case "department":
      case "notification":
      case "sale_approved":
        ctx.salidas.push({ tipo: "efecto", nodo: k, node_type: nodo.node_type });
        actual = (cfg.next_node_key as string) ?? "";
        continue;

      case "send_template": {
        const c = cfg as unknown as SendTemplateNodeConfig;
        const params = parametrosDePlantilla(c.variables ?? {}, datosFichas(ctx));
        ctx.salidas.push({
          tipo: "plantilla",
          nodo: k,
          nombre: c.template_name,
          idioma: c.language,
          parametros: params,
          escribiendo: segundosEscribiendo(""),
        });
        negocioDice(ctx, `[plantilla ${c.template_name}] ${params.join(" · ")}`);
        actual = c.next_node_key;
        continue;
      }

      case "send_payment": {
        const c = cfg as unknown as SendPaymentNodeConfig;
        const datos = combinarDatosPago(c, null);
        if (!datos.clabe || !(datos.monto > 0)) {
          terminar(ctx, "failed", "pago_sin_clabe_o_monto", "fin_error", k);
          return;
        }
        const texto = textoPagoSpei(datos, c.mensaje);
        if (c.con_boton) {
          ctx.salidas.push({
            tipo: "botones",
            nodo: k,
            texto,
            botones: BOTONES_PAGO.map((b) => ({ id: b.reply_id, titulo: b.title })),
            escribiendo: segundosEscribiendo(texto),
          });
          negocioDice(ctx, texto);
        } else {
          emitirTexto(ctx, k, texto);
        }
        estacionar(ctx, k, { tipo: "comprobante", nodo: k });
        evento(ctx, "espera_comprobante", k);
        return;
      }

      case "save_reply": {
        const c = cfg as unknown as SaveReplyNodeConfig;
        if (c.prompt_text && c.prompt_text.trim()) emitirTexto(ctx, k, iv(ctx, c.prompt_text));
        const indefinido = Boolean(c.esperar_indefinido);
        const tiempo = indefinido ? ESPERA_MAX_SEGUNDOS : esperaSegundosDe(c);
        estacionar(ctx, k, { tipo: "respuesta", nodo: k, tiempo, indefinido });
        evento(ctx, "espera_respuesta", k, { segundos: tiempo });
        return;
      }

      case "collect_input": {
        const c = cfg as unknown as CollectInputNodeConfig;
        emitirTexto(ctx, k, iv(ctx, c.prompt_text));
        estacionar(ctx, k, { tipo: "respuesta", nodo: k });
        evento(ctx, "espera_respuesta", k);
        return;
      }

      case "send_buttons":
        enviarBotones(ctx, nodo);
        estacionar(ctx, k, { tipo: "respuesta", nodo: k });
        return;

      case "send_list":
        enviarLista(ctx, nodo);
        estacionar(ctx, k, { tipo: "respuesta", nodo: k });
        return;

      case "connect_flow": {
        const c = cfg as unknown as ConnectFlowNodeConfig;
        await transferir(ctx, c.target_flow_id, k);
        return;
      }

      case "ai_block": {
        const c = cfg as unknown as AiBlockNodeConfig;
        actual = await bloqueIa(ctx, nodo, c);
        continue;
      }

      case "manipulator": {
        const c = cfg as unknown as ManipulatorNodeConfig;
        manipular(ctx, c);
        ctx.salidas.push({ tipo: "efecto", nodo: k, node_type: nodo.node_type });
        actual = c.next_node_key;
        continue;
      }

      case "distributor": {
        const c = cfg as unknown as DistributorNodeConfig;
        const salidas = c.outputs ?? [];
        if (salidas.length === 0) {
          actual = "";
        } else {
          // Reparto en rueda: cada vuelta del probador toma la salida siguiente.
          const i = (ctx.estado.distribuidor[k] ?? 0) % salidas.length;
          ctx.estado.distribuidor[k] = i + 1;
          actual = salidas[i]?.next_node_key ?? "";
          ctx.salidas.push({
            tipo: "efecto",
            nodo: k,
            node_type: nodo.node_type,
            detalle: salidas[i]?.label ?? String(i + 1),
          });
        }
        continue;
      }

      case "http_request": {
        const c = cfg as unknown as HttpRequestNodeConfig;
        actual = await httpRequest(ctx, k, c);
        if (actual === null) return;
        continue;
      }

      case "ai_media": {
        const c = cfg as unknown as { output_var?: string; next_node_key: string; kind?: string };
        const clave = c.output_var?.trim() || "ai_media_url";
        ctx.estado.vars[clave] = "(medio generado en la prueba)";
        ctx.salidas.push({ tipo: "efecto", nodo: k, node_type: nodo.node_type });
        actual = c.next_node_key;
        continue;
      }

      case "carousel": {
        const c = cfg as unknown as CarouselNodeConfig;
        if (c.intro_text?.trim()) emitirTexto(ctx, k, iv(ctx, c.intro_text));
        for (const card of c.cards ?? []) {
          const botones = (card.buttons ?? [])
            .slice(0, 3)
            .filter((b) => b.type !== "url" && b.label)
            .map((b) => ({ id: `car_${card.id}_${b.id}`, titulo: b.label.slice(0, 20) }));
          if (botones.length === 0) continue;
          const texto = iv(ctx, card.text || "—");
          ctx.salidas.push({
            tipo: "botones",
            nodo: k,
            texto,
            ...(card.image_url ? { imagen: card.image_url } : {}),
            botones,
            escribiendo: 1,
          });
          negocioDice(ctx, texto);
        }
        estacionar(ctx, k, { tipo: "carrusel", nodo: k });
        evento(ctx, "espera_carrusel", k);
        return;
      }

      case "payment_gateway": {
        const c = cfg as unknown as PaymentGatewayNodeConfig;
        if (!pasarela(ctx, k, c)) return;
        estacionar(ctx, k, { tipo: "pago", nodo: k, proveedor: c.provider });
        evento(ctx, "espera_pago", k, { proveedor: c.provider });
        return;
      }

      case "official_call": {
        const c = cfg as unknown as OfficialCallNodeConfig;
        const texto = iv(ctx, c.body_text);
        ctx.salidas.push({ tipo: "permiso_llamada", nodo: k, texto });
        negocioDice(ctx, texto);
        estacionar(ctx, k, { tipo: "permiso", nodo: k });
        evento(ctx, "espera_permiso", k);
        return;
      }

      case "handoff": {
        const c = cfg as unknown as HandoffNodeConfig;
        ctx.salidas.push({ tipo: "efecto", nodo: k, node_type: nodo.node_type });
        ctx.estado.iaPausada = c.pause_ai !== false;
        terminar(ctx, "handed_off", "handoff_node", "fin_handoff", k);
        return;
      }

      case "end":
        terminar(ctx, "completed", "end_node", "fin_nodo_end", k);
        return;

      default:
        terminar(ctx, "failed", `unknown_node_type:${nodo.node_type}`, "fin_error", k);
        return;
    }
  }
  terminar(ctx, "failed", "advance_loop_overflow", "fin_error", actual ?? undefined);
}

// ------------------------------------------------------------
// Pasos con lógica propia
// ------------------------------------------------------------

function acotar(valor: unknown, min: number, max: number, defecto: number): number {
  const n = Number(valor);
  if (!Number.isFinite(n)) return defecto;
  return Math.min(Math.max(n, min), max);
}

/** Mensaje compuesto (espejo de ejecutarBurbujas). */
function burbujas(
  ctx: Ctx,
  nodo: SimNodo,
  desde: number,
  retomada: boolean,
): "ok" | "estacionada" {
  const items = ((nodo.config as unknown as SendMessageNodeConfig).items ?? []) as BurbujaMensaje[];
  for (let i = desde; i < items.length; i += 1) {
    const b = items[i] ?? ({ tipo: "text" } as BurbujaMensaje);
    const yaEsperada = retomada && i === desde;

    if (b.tipo === "interval") {
      if (yaEsperada) continue;
      const segundos = acotar(b.segundos, 0, WAIT_MAX_SEGUNDOS, 0);
      if (segundos > WAIT_INLINE_MAX_SEGUNDOS) {
        estacionar(ctx, nodo.node_key, { tipo: "tiempo", nodo: nodo.node_key, segundos, burbuja: i });
        evento(ctx, "espera_tiempo", nodo.node_key, { segundos });
        return "estacionada";
      }
      if (segundos > 0) ctx.salidas.push({ tipo: "pausa", nodo: nodo.node_key, segundos });
      continue;
    }

    const esTexto = b.tipo === "text";
    const texto = (b.text ?? "").trim();
    if (esTexto ? !texto : !b.media_url?.trim()) continue; // burbuja vacía: se salta

    let escribiendo = 0;
    if (!yaEsperada) {
      if (b.like && ctx.estado.historial.some((t) => t.rol === "cliente")) {
        ctx.salidas.push({ tipo: "reaccion", nodo: nodo.node_key, emoji: "👍" });
      }
      escribiendo = acotar(b.segundos, 0, BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS, BURBUJA_ESCRIBIENDO_DEFECTO);
      if (escribiendo > WAIT_INLINE_MAX_SEGUNDOS) {
        estacionar(ctx, nodo.node_key, {
          tipo: "tiempo",
          nodo: nodo.node_key,
          segundos: escribiendo,
          burbuja: i,
        });
        evento(ctx, "espera_tiempo", nodo.node_key, { segundos: escribiendo });
        return "estacionada";
      }
    }

    if (esTexto) {
      emitirTexto(ctx, nodo.node_key, iv(ctx, texto), escribiendo);
    } else {
      const pie =
        b.text?.trim() && b.tipo !== "audio" && b.tipo !== "sticker" ? iv(ctx, b.text) : undefined;
      ctx.citaPendiente = null;
      ctx.salidas.push({
        tipo: "medio",
        nodo: nodo.node_key,
        medio: b.tipo as SimMedio,
        url: iv(ctx, b.media_url),
        ...(pie ? { pie } : {}),
        ...(b.tipo === "document" && b.filename ? { archivo: b.filename } : {}),
        escribiendo,
      });
      negocioDice(ctx, pie ?? `[${b.tipo}]`);
    }
  }
  return "ok";
}

function enviarBotones(ctx: Ctx, nodo: SimNodo): void {
  const c = nodo.config as unknown as SendButtonsNodeConfig;
  const texto = iv(ctx, c.text);
  ctx.citaPendiente = null;
  ctx.salidas.push({
    tipo: "botones",
    nodo: nodo.node_key,
    texto,
    encabezado: ivOpt(ctx, c.header_text),
    pie: ivOpt(ctx, c.footer_text),
    botones: (c.buttons ?? []).map((b) => ({ id: b.reply_id, titulo: iv(ctx, b.title) })),
    escribiendo: segundosEscribiendo(c.text ?? ""),
  });
  negocioDice(
    ctx,
    `${texto}\n${(c.buttons ?? []).map((b) => `[${iv(ctx, b.title)}]`).join(" ")}`,
  );
}

function enviarLista(ctx: Ctx, nodo: SimNodo): void {
  const c = nodo.config as unknown as SendListNodeConfig;
  const texto = iv(ctx, c.text);
  ctx.citaPendiente = null;
  ctx.salidas.push({
    tipo: "lista",
    nodo: nodo.node_key,
    texto,
    encabezado: ivOpt(ctx, c.header_text),
    pie: ivOpt(ctx, c.footer_text),
    boton: iv(ctx, c.button_label),
    secciones: (c.sections ?? []).map((s) => ({
      titulo: ivOpt(ctx, s.title),
      filas: (s.rows ?? []).map((r) => ({
        id: r.reply_id,
        titulo: iv(ctx, r.title),
        descripcion: ivOpt(ctx, r.description),
      })),
    })),
    escribiendo: segundosEscribiendo(c.text ?? ""),
  });
  const filas = (c.sections ?? []).flatMap((s) => s.rows ?? []).map((r) => iv(ctx, r.title));
  negocioDice(ctx, `${texto}\n${filas.map((f) => `- ${f}`).join("\n")}`);
}

/** Espera del Smart Delay en segundos (null = horario inválido). */
function segundosDeEspera(c: WaitNodeConfig): number | null {
  const modo = c.modo ?? "intervalo";
  if (modo === "fecha" || modo === "horario") {
    // En el navegador no se conoce el horario de la cuenta: se usa el
    // del nodo o el de oficina por defecto, en hora de Ciudad de México.
    const zona = c.horario?.timezone || "America/Mexico_City";
    const horario =
      modo === "horario"
        ? {
            timezone: zona,
            usar_cuenta: true,
            dias: c.horario?.dias ?? [1, 2, 3, 4, 5],
            desde: c.horario?.desde ?? "09:00",
            hasta: c.horario?.hasta ?? "18:00",
          }
        : c.horario;
    const s = esperaProgramadaSegundos({
      modo,
      fecha_objetivo: c.fecha_objetivo,
      horario,
      timeZonePorDefecto: zona,
      now: new Date(),
    });
    return s === null ? null : Math.min(s, WAIT_PROGRAMADO_MAX_SEGUNDOS);
  }
  return Math.min(Math.max(Number(c.segundos) || 0, 0), WAIT_MAX_SEGUNDOS);
}

function esperaSegundosDe(c: SaveReplyNodeConfig): number {
  if (typeof c.espera_segundos === "number" && Number.isFinite(c.espera_segundos)) {
    return Math.min(Math.max(c.espera_segundos, 0), ESPERA_MAX_SEGUNDOS);
  }
  const minutos = Number(c.espera_minutos);
  if (!Number.isFinite(minutos)) return 0;
  return Math.min(Math.max(minutos * 60, 0), ESPERA_MAX_SEGUNDOS);
}

function segundosBuffer(c: SaveReplyNodeConfig): number {
  const n = Number(c.buffer_segundos);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, BUFFER_MAX_SEGUNDOS);
}

function valorDeSujeto(
  ctx: Ctx,
  subject: ConditionNodeConfig["subject"],
  clave: string,
): string | undefined {
  if (subject === "var") {
    const v = ctx.estado.vars[clave];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
  }
  if (subject === "tag") {
    return ctx.estado.etiquetas.includes(clave) ? clave : undefined;
  }
  const raw = (ctx.estado.contacto as unknown as Record<string, unknown>)[clave];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function evaluarCondicion(ctx: Ctx, c: ConditionNodeConfig): boolean {
  const reglas = reglasDeCondicion(c);
  if (reglas.length === 0) return false;
  const resultados = reglas.map((r) =>
    evaluateConditionPredicate({
      operator: r.operator,
      subjectValue: valorDeSujeto(ctx, r.subject, r.subject_key),
      configValue: r.value,
    }),
  );
  return combinarCondiciones(resultados, c.logic ?? "all");
}

function manipular(ctx: Ctx, c: ManipulatorNodeConfig): void {
  const raw = iv(ctx, c.value ?? "");
  if (c.target === "var") {
    const n = Number(ctx.estado.vars[c.key]) || 0;
    let next: unknown;
    if (c.operation === "clear") next = "";
    else if (c.operation === "add") next = n + (Number(raw) || 0);
    else if (c.operation === "subtract") next = n - (Number(raw) || 0);
    else next = c.value_type === "number" ? Number(raw) || 0 : raw;
    ctx.estado.vars[c.key] = next;
    return;
  }
  if (["name", "email", "company"].includes(c.key)) {
    (ctx.estado.contacto as unknown as Record<string, string>)[c.key] =
      c.operation === "clear" ? "" : raw;
  }
}

async function bloqueIa(ctx: Ctx, nodo: SimNodo, c: AiBlockNodeConfig): Promise<string> {
  if (!ctx.servicios.iaBloque) {
    evento(ctx, "ia_bloque_sin_servicio", nodo.node_key);
    return c.fallback_next;
  }
  let r: { respuesta: string; salida: string | null } | null = null;
  try {
    r = await ctx.servicios.iaBloque({
      flujoId: ctx.estado.flujoId,
      nodo,
      historial: ctx.estado.historial,
      vars: ctx.estado.vars,
    });
  } catch {
    r = null;
  }
  if (!r) {
    evento(ctx, "ia_bloque_sin_servicio", nodo.node_key);
    return c.fallback_next;
  }
  ctx.estado.vars[c.output_var?.trim() || "ai.response"] = r.respuesta;
  if (c.auto_send && r.respuesta.trim()) emitirTexto(ctx, nodo.node_key, r.respuesta);
  const destino = destinoBloqueIa(c, r.salida);
  evento(ctx, "ia_bloque", nodo.node_key, { salida: r.salida ?? "default" });
  return destino;
}

/** null = la corrida terminó aquí. */
async function httpRequest(
  ctx: Ctx,
  k: string,
  c: HttpRequestNodeConfig,
): Promise<string | null> {
  if (!ctx.servicios.http) {
    evento(ctx, "http_simulado", k, { metodo: c.method, url: c.url });
    return c.next_node_key;
  }
  let r: { ok: boolean; status: number; mapped: Record<string, unknown> } | null = null;
  try {
    r = await ctx.servicios.http({ cfg: c, vars: ctx.estado.vars });
  } catch {
    r = null;
  }
  if (!r) {
    if (c.continue_on_error === false) {
      terminar(ctx, "failed", "http_request_failed", "fin_error", k);
      return null;
    }
    return c.error_next || c.next_node_key;
  }
  Object.assign(ctx.estado.vars, r.mapped);
  if (c.status_var?.trim()) ctx.estado.vars[c.status_var.trim()] = String(r.status);
  evento(ctx, "http_real", k, { status: r.status });
  if (r.ok) return c.next_node_key;
  if (c.error_next) return c.error_next;
  if (c.continue_on_error === false) {
    terminar(ctx, "failed", "http_request_failed", "fin_error", k);
    return null;
  }
  return c.next_node_key;
}

/** Manda el pago de la pasarela. false = la corrida terminó con error. */
function pasarela(ctx: Ctx, k: string, c: PaymentGatewayNodeConfig): boolean {
  const monto =
    c.amount_mode === "variable" && c.amount_var
      ? Number(ctx.estado.vars[c.amount_var]) || 0
      : Number(c.amount) || 0;
  if (!(monto > 0)) {
    terminar(ctx, "failed", "payment_amount_invalid", "fin_error", k);
    return false;
  }
  const referencia = `pay_${c.provider}_prueba`;
  ctx.estado.vars.__payment_ref = referencia;
  const url = sustituirFichas(c.checkout_url ?? "", datosFichas(ctx))
    .replace(/\{\{\s*payment_ref\s*\}\}/g, referencia)
    .replace(/\{\{\s*amount\s*\}\}/g, String(monto))
    .replace(/\{\{\s*currency\s*\}\}/g, c.currency)
    .replace(/\{\{\s*reference\s*\}\}/g, referencia);
  if (c.provider !== "spei" && !url.trim()) {
    terminar(ctx, "failed", "payment_checkout_missing", "fin_error", k);
    return false;
  }
  if (c.provider === "spei") {
    const datos = combinarDatosPago(
      {
        clabe: "",
        beneficiario: "",
        banco: "",
        monto,
        referencia,
        mensaje: c.concept,
        con_boton: false,
        espera_minutos: c.wait_minutes,
        aprobado_next: "",
        rechazado_next: "",
      },
      null,
    );
    emitirTexto(ctx, k, textoPagoSpei(datos, c.message));
    return true;
  }
  const mensaje = sustituirFichas(
    c.message?.trim() || "Aquí tienes tu enlace de pago seguro 👇",
    datosFichas(ctx),
  );
  emitirTexto(ctx, k, `${mensaje}\n\n${url}`);
  return true;
}

async function transferir(ctx: Ctx, destino: string | undefined, k: string): Promise<void> {
  if (!destino) {
    terminar(ctx, "completed", "connect_flow_sin_destino", "fin_error", k);
    return;
  }
  const otro = ctx.servicios.cargarFlujo ? await ctx.servicios.cargarFlujo(destino).catch(() => null) : null;
  if (!otro || !otro.entry_node_id) {
    terminar(ctx, "completed", "connect_flow_destino_invalido", "fin_error", k);
    return;
  }
  if (!puedeTransferir(ctx.estado.cadena, destino)) {
    terminar(ctx, "completed", "connect_flow_bucle", "fin_error", k);
    return;
  }
  ctx.estado.cadena.push(destino);
  ctx.estado.flujoId = destino;
  ctx.flujo = otro;
  ctx.nodos = new Map(otro.nodes.map((n) => [n.node_key, n]));
  ctx.estado.reprompts = 0;
  evento(ctx, "transferido", k, { flujo: otro.name ?? destino });
  await avanzar(ctx, otro.entry_node_id);
}

// ============================================================
// Entradas
// ============================================================

/** ¿Este mensaje arrancaría el flujo? (espejo de findEntryFlow para UN flujo). */
export function disparaElFlujo(
  flujo: Pick<SimFlujo, "trigger_type" | "trigger_config">,
  estado: Pick<SimEstado, "yaEscribio" | "yaCorrio">,
  entrada: SimEntrada,
): boolean {
  const candidatos =
    entrada.kind === "text"
      ? [entrada.text]
      : entrada.kind === "media"
        ? [entrada.caption]
        : [...new Set([entrada.title, entrada.reply_id])].filter((v) => v && v.trim());
  if (flujo.trigger_type === "keyword") {
    const cfg = flujo.trigger_config as unknown as KeywordTriggerConfig;
    return candidatos.some((t) => matchesKeywordTrigger(t, cfg));
  }
  if (flujo.trigger_type === "first_inbound_message") return !estado.yaEscribio;
  if (flujo.trigger_type === "any_message") return !estado.yaCorrio;
  return false; // manual: no arranca solo
}

function textoDeEntrada(entrada: SimEntrada): string {
  if (entrada.kind === "text") return entrada.text;
  if (entrada.kind === "tap") return entrada.title;
  return entrada.caption || (entrada.media_type === "image" ? "[foto]" : "[documento]");
}

/**
 * Arranca una corrida nueva desde la entrada del flujo, sin mirar el
 * disparador (botón «Arrancar» del probador o disparador manual).
 */
export async function arrancar(
  estadoPrevio: SimEstado,
  flujo: SimFlujo,
  servicios: SimServicios = {},
): Promise<SimResultado> {
  const estado = clonar(estadoPrevio);
  estado.flujoId = flujo.id;
  estado.fase = "activa";
  estado.fin = null;
  estado.reprompts = 0;
  estado.cadena = [];
  estado.iaPausada = false;
  estado.yaCorrio = true;
  const ctx = crearCtx(estado, flujo, servicios);
  evento(ctx, "inicio");
  if (!flujo.entry_node_id) {
    terminar(ctx, "failed", "sin_entrada", "fin_error");
  } else {
    await avanzar(ctx, flujo.entry_node_id);
  }
  return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
}

/**
 * La clienta manda un mensaje. `flujo` es el flujo en curso (si hubo un
 * «Conectar flujo», el destino); la vista lo resuelve con `estado.flujoId`.
 */
export async function recibir(
  estadoPrevio: SimEstado,
  flujo: SimFlujo,
  entrada: SimEntrada,
  servicios: SimServicios = {},
): Promise<SimResultado> {
  const estado = clonar(estadoPrevio);
  estado.historial.push({ rol: "cliente", texto: textoDeEntrada(entrada) });

  if (estado.fase !== "activa") {
    const dispara = disparaElFlujo(flujo, estado, entrada);
    estado.yaEscribio = true;
    if (!dispara) {
      const ctx = crearCtx(estado, flujo, servicios);
      evento(ctx, "no_dispara");
      return { estado: ctx.estado, salidas: ctx.salidas, consumido: false };
    }
    return arrancar(estado, flujo, servicios);
  }

  estado.yaEscribio = true;
  const ctx = crearCtx(estado, flujo, servicios);
  const consumido = await responder(ctx, entrada);
  return { estado: ctx.estado, salidas: ctx.salidas, consumido };
}

/** Espejo de handleReplyForActiveRun. Devuelve si el flujo tomó el mensaje. */
async function responder(ctx: Ctx, entradaOriginal: SimEntrada): Promise<boolean> {
  const nodo = ctx.estado.actual ? ctx.nodos.get(ctx.estado.actual) : undefined;
  if (!nodo) {
    // El nodo se borró en el editor mientras se probaba.
    terminar(ctx, "completed", "current_node_removed", "fin_error", ctx.estado.actual ?? undefined);
    return false;
  }
  const k = nodo.node_key;
  const espera = ctx.estado.espera;

  if (nodo.node_type === "payment_gateway") {
    const c = nodo.config as unknown as PaymentGatewayNodeConfig;
    if (c.provider === "spei" && entradaOriginal.kind === "media") {
      return comprobante(ctx, k, entradaOriginal.comprobante, c.approved_next, c.rejected_next, c.etiqueta_al_aprobar);
    }
    evento(ctx, "mensaje_en_espera", k);
    return true;
  }

  if (
    nodo.node_type === "wait" ||
    nodo.node_type === "official_call" ||
    (nodo.node_type === "send_message" && espera?.tipo === "tiempo")
  ) {
    evento(ctx, "mensaje_en_espera", k);
    return true;
  }

  if (nodo.node_type === "send_payment") {
    const c = nodo.config as unknown as SendPaymentNodeConfig;
    if (entradaOriginal.kind === "tap") {
      if (BOTONES_PAGO.some((b) => b.reply_id === entradaOriginal.reply_id)) {
        emitirTexto(ctx, k, TEXTO_PIDE_COMPROBANTE);
      }
      return true;
    }
    if (entradaOriginal.kind !== "media") {
      evento(ctx, "mensaje_en_espera", k);
      return true;
    }
    return comprobante(
      ctx,
      k,
      entradaOriginal.comprobante,
      c.aprobado_next,
      c.rechazado_next,
      c.etiqueta_al_aprobar || "pagado",
    );
  }

  // Para cualquier otro nodo, una imagen o documento cuenta como texto con su pie.
  const entrada: SimEntrada =
    entradaOriginal.kind === "media" ? { kind: "text", text: entradaOriginal.caption } : entradaOriginal;

  if (nodo.node_type === "carousel") {
    if (entrada.kind === "tap") {
      const c = nodo.config as unknown as CarouselNodeConfig;
      let destino: string | undefined;
      for (const card of c.cards ?? []) {
        for (const b of card.buttons ?? []) {
          if (`car_${card.id}_${b.id}` === entrada.reply_id) destino = b.next_node_key;
        }
      }
      if (destino) {
        ctx.estado.reprompts = 0;
        await avanzar(ctx, destino);
        return true;
      }
    }
    return true;
  }

  if (nodo.node_type === "save_reply") {
    const c = nodo.config as unknown as SaveReplyNodeConfig;
    const ventana = segundosBuffer(c);
    if (espera?.tipo === "buffer" || ventana > 0) {
      if (entrada.kind !== "text" || !entrada.text.trim()) return true;
      const texto = entrada.text.trim();
      if (espera?.tipo === "buffer") {
        espera.textos.push(texto);
        return true;
      }
      if (c.reaccionar) ctx.salidas.push({ tipo: "reaccion", nodo: k, emoji: "👍" });
      ctx.estado.espera = { tipo: "buffer", nodo: k, segundos: ventana, textos: [texto] };
      evento(ctx, "buffer_abierto", k, { segundos: ventana });
      return true;
    }
  }

  let destino: string | null = null;
  if (entrada.kind === "tap" && (nodo.node_type === "send_buttons" || nodo.node_type === "send_list")) {
    destino = matchReplyId(nodo, entrada.reply_id);
  } else if (
    entrada.kind === "text" &&
    (nodo.node_type === "send_buttons" || nodo.node_type === "send_list")
  ) {
    destino = matchTypedReply(nodo, entrada.text);
  } else if (entrada.kind === "text" && nodo.node_type === "save_reply") {
    const c = nodo.config as unknown as SaveReplyNodeConfig;
    const capturado = entrada.text.trim();
    if (capturado && c.var_key && c.contesto_next) {
      capturar(ctx, k, c, capturado);
      ctx.estado.reprompts = 0;
      await avanzar(ctx, c.contesto_next);
      return true;
    }
  } else if (entrada.kind === "text" && nodo.node_type === "collect_input") {
    const c = nodo.config as unknown as CollectInputNodeConfig;
    const capturado = entrada.text.trim();
    if (capturado && c.var_key && c.next_node_key) {
      ctx.estado.vars[c.var_key] = capturado;
      evento(ctx, "variable_guardada", k, { clave: c.var_key, valor: capturado });
      ctx.estado.reprompts = 0;
      await avanzar(ctx, c.next_node_key);
      return true;
    }
  }

  if (destino) {
    ctx.estado.reprompts = 0;
    await avanzar(ctx, destino);
    return true;
  }

  // Sin coincidencia → política de fallback del flujo.
  const politica = resolveFallbackPolicy(ctx.flujo.fallback_policy);
  const intentos = ctx.estado.reprompts + 1;
  const accion = decideFallback({ policy: politica, reprompt_count: intentos });
  if (accion.type === "ignore") {
    evento(ctx, "fallback_ignora", k);
    return false;
  }
  ctx.estado.reprompts = intentos;
  if (accion.type === "reprompt") {
    evento(ctx, "fallback_repregunta", k, { intento: intentos, maximo: politica.max_reprompts });
    if (nodo.node_type === "send_buttons") enviarBotones(ctx, nodo);
    else if (nodo.node_type === "send_list") enviarLista(ctx, nodo);
    else if (nodo.node_type === "collect_input") {
      emitirTexto(ctx, k, iv(ctx, (nodo.config as unknown as CollectInputNodeConfig).prompt_text));
    }
    return true;
  }
  if (accion.type === "handoff") {
    terminar(ctx, "handed_off", "fallback_exhausted", "fallback_agotado_humano", k);
    return true;
  }
  terminar(ctx, "completed", "fallback_exhausted_end", "fallback_agotado_fin", k);
  return true;
}

function capturar(ctx: Ctx, k: string, c: SaveReplyNodeConfig, capturado: string): void {
  ctx.estado.vars[c.var_key] = capturado;
  if (c.citar_respuesta) ctx.citaPendiente = capturado;
  if (c.reaccionar) ctx.salidas.push({ tipo: "reaccion", nodo: k, emoji: "👍" });
  const campo = c.campo_contacto;
  if (campo === "name" || campo === "email" || campo === "company") {
    ctx.estado.contacto[campo] = capturado;
  } else if (campo?.startsWith("custom:")) {
    ctx.estado.vars[campo] = capturado;
  }
  evento(ctx, "variable_guardada", k, { clave: c.var_key, valor: capturado });
}

/** Comprobante de pago (Botón Pago y Pasarela SPEI). */
async function comprobante(
  ctx: Ctx,
  k: string,
  lectura: "valido" | "invalido" | "no",
  aprobado: string | undefined,
  rechazado: string | undefined,
  etiqueta: string | undefined,
): Promise<boolean> {
  if (lectura === "no") {
    emitirTexto(ctx, k, TEXTO_NO_ES_COMPROBANTE);
    evento(ctx, "no_es_comprobante", k);
    return true;
  }
  if (lectura === "valido") {
    if (etiqueta) ctx.estado.etiquetas.push(etiqueta);
    evento(ctx, "pago_aprobado", k);
    await avanzar(ctx, aprobado);
    return true;
  }
  evento(ctx, "pago_rechazado", k);
  if (rechazado) await avanzar(ctx, rechazado);
  else terminar(ctx, "completed", "pago_rechazado", "fin_de_rama", k);
  return true;
}

// ============================================================
// Acciones del probador (lo que en producción hace el cron o un webhook)
// ============================================================

/** Qué acciones tienen sentido en la espera actual. */
export function accionesDisponibles(estado: SimEstado, flujo: SimFlujo): SimAccion[] {
  if (estado.fase !== "activa" || !estado.espera) return [];
  const e = estado.espera;
  const nodo = flujo.nodes.find((n) => n.node_key === e.nodo);
  switch (e.tipo) {
    case "tiempo":
      // «Fuera de ventana» solo aplica al Smart Delay (las burbujas no la revisan).
      return nodo?.node_type === "wait" ? ["adelantar", "fuera_de_ventana"] : ["adelantar"];
    case "buffer":
      return ["adelantar"];
    case "respuesta":
      return nodo?.node_type === "save_reply" && !e.indefinido && (e.tiempo ?? 0) > 0
        ? ["no_contesta"]
        : [];
    case "comprobante":
      return ["pago_aprobado", "pago_rechazado", "no_contesta"];
    case "pago":
      return ["pago_aprobado", "pago_rechazado", "no_contesta"];
    case "permiso":
      return ["permiso_aceptado", "permiso_rechazado", "no_contesta"];
    case "carrusel":
      return ["no_contesta"];
  }
}

export async function accion(
  estadoPrevio: SimEstado,
  flujo: SimFlujo,
  que: SimAccion,
  servicios: SimServicios = {},
): Promise<SimResultado> {
  const estado = clonar(estadoPrevio);
  const ctx = crearCtx(estado, flujo, servicios);
  const e = estado.espera;
  const nodo = e ? ctx.nodos.get(e.nodo) : undefined;
  if (estado.fase !== "activa" || !e || !nodo) {
    return { estado, salidas: [], consumido: true };
  }
  const k = nodo.node_key;
  const cfg = nodo.config;
  estado.espera = null;

  if (e.tipo === "tiempo") {
    if (que === "fuera_de_ventana") {
      // Venció con la ventana de 24 h cerrada: no se manda nada.
      evento(ctx, "fuera_de_ventana", k);
      const salida = nodo.node_type === "wait" ? (cfg as unknown as WaitNodeConfig).fuera_ventana_next : undefined;
      if (salida) await avanzar(ctx, salida);
      else terminar(ctx, "completed", "fuera_de_ventana", "fin_de_rama", k);
    } else if (nodo.node_type === "send_message" && e.burbuja !== undefined) {
      const r = burbujas(ctx, nodo, e.burbuja, true);
      if (r === "ok") await avanzar(ctx, (cfg as unknown as SendMessageNodeConfig).next_node_key || null);
    } else {
      await avanzar(ctx, (cfg as unknown as WaitNodeConfig).next_node_key || null);
    }
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "buffer") {
    const c = cfg as unknown as SaveReplyNodeConfig;
    const textos = e.textos.map((t) => t.trim()).filter(Boolean);
    if (textos.length === 0 || !c.var_key || !c.contesto_next) {
      estado.espera = { tipo: "respuesta", nodo: k };
      return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
    }
    capturar(ctx, k, c, textos.join("\n"));
    await avanzar(ctx, c.contesto_next);
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "respuesta" && que === "no_contesta") {
    const c = cfg as unknown as SaveReplyNodeConfig;
    evento(ctx, "no_contesto", k);
    if (c.no_contesto_next) await avanzar(ctx, c.no_contesto_next);
    else terminar(ctx, "completed", "reply_timeout", "fin_de_rama", k);
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "comprobante") {
    const c = cfg as unknown as SendPaymentNodeConfig;
    if (que === "pago_aprobado") {
      await comprobante(ctx, k, "valido", c.aprobado_next, c.rechazado_next, c.etiqueta_al_aprobar || "pagado");
    } else {
      // Rechazado o venció la espera: ambos van por «rechazado».
      evento(ctx, que === "no_contesta" ? "no_contesto" : "pago_rechazado", k);
      if (c.rechazado_next) await avanzar(ctx, c.rechazado_next);
      else terminar(ctx, "failed", "missing_next_node", "fin_error", k);
    }
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "pago") {
    const c = cfg as unknown as PaymentGatewayNodeConfig;
    if (que === "pago_aprobado") {
      if (c.etiqueta_al_aprobar) estado.etiquetas.push(c.etiqueta_al_aprobar);
      evento(ctx, "pago_aprobado", k);
      await avanzar(ctx, c.approved_next);
    } else if (que === "pago_rechazado") {
      evento(ctx, "pago_rechazado", k);
      const salida = c.rejected_next || c.timeout_next;
      if (salida) await avanzar(ctx, salida);
      else terminar(ctx, "failed", "missing_next_node", "fin_error", k);
    } else {
      evento(ctx, "no_contesto", k);
      const salida = c.timeout_next || c.rejected_next;
      if (salida) await avanzar(ctx, salida);
      else terminar(ctx, "failed", "missing_next_node", "fin_error", k);
    }
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "permiso") {
    const c = cfg as unknown as OfficialCallNodeConfig;
    const salida =
      que === "permiso_aceptado"
        ? c.granted_next
        : que === "permiso_rechazado"
          ? c.denied_next
          : c.timeout_next || c.denied_next;
    evento(
      ctx,
      que === "permiso_aceptado" ? "permiso_aceptado" : que === "permiso_rechazado" ? "permiso_rechazado" : "no_contesto",
      k,
    );
    if (salida) await avanzar(ctx, salida);
    else terminar(ctx, "failed", "missing_next_node", "fin_error", k);
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  if (e.tipo === "carrusel") {
    const c = cfg as unknown as CarouselNodeConfig;
    evento(ctx, "no_contesto", k);
    if (c.timeout_next) await avanzar(ctx, c.timeout_next);
    else terminar(ctx, "completed", "carousel_timeout", "fin_de_rama", k);
    return { estado: ctx.estado, salidas: ctx.salidas, consumido: true };
  }

  estado.espera = e;
  return { estado, salidas: [], consumido: true };
}

/** Temas que el negocio ya comunicó (memoria de la IA), desde el historial. */
export function textosDelNegocio(estado: SimEstado): string[] {
  return estado.historial.filter((t) => t.rol === "negocio").map((t) => t.texto);
}
