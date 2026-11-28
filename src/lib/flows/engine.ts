/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendReaction,
  engineSendText,
  mostrarEscribiendo,
} from "./meta-send";

/**
 * wamid del último mensaje de la clienta. Meta lo exige para poder
 * mostrar «escribiendo…»; el run no lo guarda, así que se consulta al
 * vuelo (consulta indexada, un registro).
 */
async function wamidEntrante(
  db: AdminClient,
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const { data } = await db
      .from("messages")
      .select("message_id")
      .eq("conversation_id", conversationId)
      .eq("sender_type", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { message_id: string } | null)?.message_id ?? null;
  } catch {
    // Sin wamid no hay «escribiendo…», pero la pausa sí se respeta y el
    // mensaje sale igual: esto es cosmético y nunca frena el embudo.
    return null;
  }
}

/**
 * «Escribiendo…» + pausa de 3–7 s antes de cada mensaje del flujo, para
 * que la secuencia no le llegue de golpe a la clienta.
 *
 * Envuelto en try/catch a propósito: el ritmo es cosmético. Si algo
 * falla aquí, el mensaje tiene que salir igual.
 */
async function ritmoHumano(
  db: AdminClient,
  run: FlowRunRow,
  texto?: string,
): Promise<void> {
  try {
    await mostrarEscribiendo({
      accountId: run.account_id,
      messageId: await wamidEntrante(db, run.conversation_id),
      texto,
    });
  } catch (err) {
    console.warn(
      "[flows] no se pudo mostrar «escribiendo…»:",
      err instanceof Error ? err.message : err,
    );
  }
}
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { enviarEventoMeta, guardarValor } from "@/lib/ventas/conversiones";
import { enviarVentaLowtrack } from "@/lib/integraciones/lowtrack";
import { sumarVariablesGlobales } from "./globales";
import {
  candidatosEstandar,
  flujoPorPalabraClave,
  HORAS_PREDETERMINADA,
  normalizarFlujosEstandar,
  tieneFlujosEstandar,
} from "./estandar";
import { etiquetar, leerComprobanteDeMedio } from "@/lib/ventas/comprobante";
import { combinarCondiciones, destinoBloqueIa, parsearSalidaIa, promptSistemaBloqueIa, puedeTransferir, reglasDeCondicion } from "./bloques-avanzados";
import { esperaProgramadaSegundos } from "./agenda";
import { ejecutarHttpRequest } from "./http-request";
import { generarMediaIA } from "./ai-media";
import {
  cargarPuenteSip,
  disponibilidadPorPais,
  dispararPuenteSip,
  estadoDesdeSettings,
  refrescarEstadoLlamadas,
  solicitarPermisoLlamada,
} from "./official-call";
import { generarReferencia } from "./pagos";
import { loadAiConfig } from "@/lib/ai/config";
import { generateReply } from "@/lib/ai/generate";
import { decrypt } from "@/lib/whatsapp/encryption";
import { credencialesDeConversacion, credencialesPrimarias } from "@/lib/whatsapp/connections";
import { engineSendTemplate } from "@/lib/automations/meta-send";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { loadAccountMetaCredentials } from "./meta-send";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";
import {
  BOTONES_PAGO,
  TEXTO_NO_ES_COMPROBANTE,
  TEXTO_PIDE_COMPROBANTE,
  cargarDatosFichas,
  combinarDatosPago,
  moverContactoEnKanban,
  parametrosDePlantilla,
  sustituirFichas,
  textoPagoSpei,
  veredictoPago,
  type DatosPago,
} from "./bloques";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { checkRunTimeout, markRunTimedOut, type RunTimeoutCheck } from "./timeout";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type ConnectFlowNodeConfig,
  type AiBlockNodeConfig,
  type ManipulatorNodeConfig,
  type DistributorNodeConfig,
  type NotificationNodeConfig,
  type SaleApprovedNodeConfig,
  type CarouselNodeConfig,
  type DepartmentNodeConfig,
  type HttpRequestNodeConfig,
  type PaymentGatewayNodeConfig,
  type AiMediaNodeConfig,
  type OfficialCallNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SaveReplyNodeConfig,
  type WaitNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type MetaCapiNodeConfig,
  type MoveKanbanNodeConfig,
  type SendPaymentNodeConfig,
  type SendTemplateNodeConfig,
  type BurbujaMensaje,
  type BufferRespuesta,
  ANY_MESSAGE_COOLDOWN_MS,
  AUTO_ADVANCING_NODE_TYPES,
  BUFFER_MAX_SEGUNDOS,
  BURBUJA_ESCRIBIENDO_DEFECTO,
  BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS,
  CALL_PERMISSION_MAX_DIAS,
  ESPERA_MAX_SEGUNDOS,
  MAX_NODES_PER_ADVANCE,
  NODOS_FIN_DE_RAMA,
  PAYMENT_GATEWAY_MAX_MINUTOS,
  VAR_BUFFER,
  VAR_CALL_SESSION,
  VAR_CURSOR_BURBUJA,
  VAR_PAYMENT_REF,
  VAR_PAYMENT_SESSION,
  VAR_PAYMENT_STATUS,
  VAR_REPLY_TO,
  VENTANA_SERVICIO_MS,
  WAIT_INLINE_MAX_SEGUNDOS,
  WAIT_MAX_SEGUNDOS,
  WAIT_PROGRAMADO_MAX_SEGUNDOS,
} from "./types";
import {
  evaluateConditionPredicate,
  interpolateOptionalVars,
  interpolateVars,
  matchReplyId,
  matchesKeywordTrigger,
  matchTypedReply,
} from "./respuestas";

// Las reglas puras viven en `respuestas.ts` (las comparte el simulador
// del editor). Se re-exportan para quien ya las importaba desde aquí.
export {
  evaluateConditionPredicate,
  matchReplyId,
  matchesKeywordTrigger,
  matchTypedReply,
  normalizarRespuesta,
  numeroEscrito,
  rangoDeTitulo,
} from "./respuestas";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  // Imagen o documento: la palabra clave solo puede venir en su pie de foto.
  if (message.kind === "text" || message.kind === "media") return [message.text];
  // El permiso de llamada no dispara flujos por palabra clave.
  if (message.kind === "call_permission") return [];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return AUTO_ADVANCING_NODE_TYPES.has(node_type);
}

export type ActiveRunClosure =
  | { kind: "cancel"; reason: "flow_not_active" | "current_node_removed" }
  | { kind: "fail"; reason: "active_run_missing_current_node" }
  | { kind: "timeout"; check: RunTimeoutCheck };

export function closureForActiveRun(args: {
  run: Pick<FlowRunRow, "current_node_key" | "last_advanced_at"> &
    Partial<Pick<FlowRunRow, "next_run_at">>;
  flow: Pick<FlowRow, "status" | "fallback_policy"> | null;
  nodeKeys: ReadonlySet<string> | { has(key: string): boolean };
  now: Date;
}): ActiveRunClosure | null {
  if (!args.flow || args.flow.status !== "active") {
    return { kind: "cancel", reason: "flow_not_active" };
  }
  // Una corrida estacionada a propósito (Smart Delay o espera de
  // respuesta) no se da por abandonada antes de que venza su temporizador.
  const estacionada =
    !!args.run.next_run_at &&
    new Date(args.run.next_run_at).getTime() > args.now.getTime();
  const check = checkRunTimeout(
    args.run.last_advanced_at,
    args.flow.fallback_policy,
    args.now,
  );
  if (check.timedOut && !estacionada) return { kind: "timeout", check };
  if (!args.run.current_node_key) {
    return { kind: "fail", reason: "active_run_missing_current_node" };
  }
  if (!args.nodeKeys.has(args.run.current_node_key)) {
    return { kind: "cancel", reason: "current_node_removed" };
  }
  return null;
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "save_reply" ||
    node_type === "payment_gateway" ||
    node_type === "official_call"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}


// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw new Error(`loadFlow failed: ${error.message}`);
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) throw new Error(`loadAllNodes failed: ${error.message}`);
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  contactId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  connectionId?: string | null,
  reabierta = false,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Flujos estándar del número (Configuración → Flujos estándar, como
  // Leona): palabras clave → bienvenida → conversación finalizada →
  // respuesta predeterminada. Si no aplica ninguno, siguen los
  // disparadores de cada flujo.
  if (connectionId) {
    const estandar = await flujoEstandarDeEntrada(db, {
      accountId,
      contactId,
      connectionId,
      textos: candidates,
      primerMensaje: isFirstInbound,
      reabierta,
    });
    if (estandar) return estandar;
  }

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = (flows as FlowRow[]).filter(
    (f) =>
      !connectionId ||
      !(f as { connection_id?: string | null }).connection_id ||
      (f as { connection_id?: string | null }).connection_id === connectionId,
  );
  // Prioridad (regla de Julián, 22-nov-2026): palabra clave → primer
  // mensaje → cualquier mensaje. Dentro de cada grupo, el más antiguo.
  for (const flow of typed) {
    if (flow.trigger_type !== "keyword") continue;
    const cfg = flow.trigger_config as KeywordTriggerConfig;
    if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
      return flow;
    }
  }
  if (isFirstInbound) {
    // Also reachable by a tap: a broadcast template with a quick-reply
    // button can genuinely be what prompts a contact's first-ever
    // inbound (the webhook pushes `first_inbound_message` regardless
    // of envelope).
    const primero = typed.find((f) => f.trigger_type === "first_inbound_message");
    if (primero) return primero;
  }
  for (const flow of typed) {
    if (flow.trigger_type !== "any_message") continue;
    // Una vez por contacto cada 24 h: si no, al terminar el flujo el
    // siguiente mensaje lo volvería a arrancar y la IA nunca tomaría el chat.
    const desde = new Date(Date.now() - ANY_MESSAGE_COOLDOWN_MS).toISOString();
    const { data: reciente, error: errReciente } = await db
      .from("flow_runs")
      .select("id")
      .eq("flow_id", flow.id)
      .eq("contact_id", contactId)
      .gte("started_at", desde)
      .limit(1);
    if (errReciente) continue;
    if (!reciente || reciente.length === 0) return flow;
  }
  // 'manual' triggers do not auto-start from inbound messages.
  return null;
}

/** Flujo estándar que toca, o null. Nunca lanza. */
async function flujoEstandarDeEntrada(
  db: AdminClient,
  args: {
    accountId: string;
    contactId: string;
    connectionId: string;
    textos: string[];
    primerMensaje: boolean;
    reabierta: boolean;
  },
): Promise<FlowRow | null> {
  try {
    const { data: conn } = await db
      .from("whatsapp_connections")
      .select("standard_flows")
      .eq("id", args.connectionId)
      .eq("account_id", args.accountId)
      .maybeSingle();
    const cfg = normalizarFlujosEstandar((conn as { standard_flows?: unknown } | null)?.standard_flows);
    if (!tieneFlujosEstandar(cfg)) return null;
    for (const c of candidatosEstandar(cfg, args)) {
      const { data: flow } = await db
        .from("flows")
        .select("*")
        .eq("id", c.flowId)
        .eq("account_id", args.accountId)
        .eq("status", "active")
        .maybeSingle();
      if (!flow) continue;
      if (c.motivo === "default_reply") {
        // Una vez por contacto en la ventana de inactividad (24 h por defecto).
        const horas = cfg.default_reply_hours ?? HORAS_PREDETERMINADA;
        if (horas > 0) {
          const desde = new Date(Date.now() - horas * 3_600_000).toISOString();
          const { data: reciente } = await db
            .from("flow_runs")
            .select("id")
            .eq("flow_id", c.flowId)
            .eq("contact_id", args.contactId)
            .gte("started_at", desde)
            .limit(1);
          if (reciente && reciente.length > 0) continue;
        }
      }
      return flow as FlowRow;
    }
  } catch (err) {
    console.warn("[flows] flujos estándar no disponibles:", err instanceof Error ? err.message : err);
  }
  return null;
}

/**
 * Palabra clave de Flujos estándar del número → su flujo (activo). Sirve
 * para que un anuncio con la palabra de OTRO producto saque al contacto
 * del embudo en que está y lo meta al nuevo. Nunca lanza.
 */
async function flujoPorPalabraClaveDelNumero(
  db: AdminClient,
  accountId: string,
  connectionId: string,
  textos: string[],
): Promise<FlowRow | null> {
  if (textos.length === 0) return null;
  try {
    const { data: conn } = await db
      .from("whatsapp_connections")
      .select("standard_flows")
      .eq("id", connectionId)
      .eq("account_id", accountId)
      .maybeSingle();
    const cfg = normalizarFlujosEstandar((conn as { standard_flows?: unknown } | null)?.standard_flows);
    const flowId = flujoPorPalabraClave(cfg, textos);
    if (!flowId) return null;
    const { data: flow } = await db
      .from("flows")
      .select("*")
      .eq("id", flowId)
      .eq("account_id", accountId)
      .eq("status", "active")
      .maybeSingle();
    return (flow as FlowRow | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Flujo estándar «Atención finalizada»: al marcar la conversación como
 * completada arranca el flujo configurado en su número (si el contacto
 * no está ya en otro flujo). Nunca lanza.
 */
export async function iniciarFlujoAtencionFinalizada(args: {
  accountId: string;
  userId: string;
  contactId: string;
  conversationId: string;
  connectionId: string | null;
}): Promise<{ iniciado: boolean; motivo?: string }> {
  const db = supabaseAdmin();
  try {
    if (!args.connectionId) return { iniciado: false, motivo: "sin_conexion" };
    const { data: conn } = await db
      .from("whatsapp_connections")
      .select("standard_flows")
      .eq("id", args.connectionId)
      .eq("account_id", args.accountId)
      .maybeSingle();
    const cfg = normalizarFlujosEstandar((conn as { standard_flows?: unknown } | null)?.standard_flows);
    if (!cfg.attendance_finished_flow_id) return { iniciado: false, motivo: "sin_flujo" };
    if (await loadActiveRunForContact(db, args.accountId, args.contactId)) {
      return { iniciado: false, motivo: "ya_en_flujo" };
    }
    const flow = await loadFlow(db, cfg.attendance_finished_flow_id);
    if (!flow || flow.status !== "active" || flow.account_id !== args.accountId || !flow.entry_node_id) {
      return { iniciado: false, motivo: "flujo_inactivo" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    const r = await startNewRun(
      db,
      flow,
      {
        accountId: args.accountId,
        userId: args.userId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        connectionId: args.connectionId,
        message: { kind: "text", text: "", meta_message_id: `atencion-finalizada-${Date.now()}` },
      },
      nodes,
    );
    return { iniciado: r.consumed };
  } catch (err) {
    console.error("[flows] atención finalizada:", err instanceof Error ? err.message : err);
    return { iniciado: false, motivo: "error" };
  }
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Texto que verá el cliente: define cuánto dura el «escribiendo…».
  const textoDelNodo = cfg.text ?? "";
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  await ritmoHumano(db, run, textoDelNodo);
  const replyTo = leerReplyTo(run);
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    ...(replyTo ? { contextMessageId: replyTo } : {}),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  if (replyTo) await limpiarReplyTo(db, run);
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const textoDelNodo = cfg.text ?? "";
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  await ritmoHumano(db, run, textoDelNodo);
  const replyTo = leerReplyTo(run);
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    ...(replyTo ? { contextMessageId: replyTo } : {}),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  if (replyTo) await limpiarReplyTo(db, run);
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as {
    assign_to?: string;
    note?: string;
    status?: "pending" | "open" | "closed";
    pause_ai?: boolean;
  };
  const convUpdate: Record<string, unknown> = {
    status: cfg.status ?? "pending",
    ai_autoreply_disabled: cfg.pause_ai !== false,
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function valorDeSujeto(
  db: AdminClient,
  run: FlowRunRow,
  subject: ConditionNodeConfig["subject"],
  subjectKey: string,
): Promise<string | undefined> {
  if (subject === "var") {
    const v = run.vars[subjectKey];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
  }
  if (subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", subjectKey);
    return (count ?? 0) > 0 ? subjectKey : undefined;
  }
  const ALLOWED = ["name", "email", "phone", "company"] as const;
  type AllowedField = (typeof ALLOWED)[number];
  if (!ALLOWED.includes(subjectKey as AllowedField)) {
    throw new Error(`unsupported contact_field: ${subjectKey}`);
  }
  const { data } = await db
    .from("contacts")
    .select(subjectKey)
    .eq("id", run.contact_id!)
    .maybeSingle();
  const raw = (data as Record<string, unknown> | null)?.[subjectKey];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  const reglas = reglasDeCondicion(cfg);
  if (reglas.length === 0) return false;
  const resultados: boolean[] = [];
  for (const regla of reglas) {
    const valor = await valorDeSujeto(
      db,
      run,
      regla.subject,
      regla.subject_key,
    );
    resultados.push(
      evaluateConditionPredicate({
        operator: regla.operator,
        subjectValue: valor,
        configValue: regla.value,
      }),
    );
  }
  return combinarCondiciones(resultados, cfg.logic ?? "all");
}


async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "cancelled" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId)
    .eq("status", "active");
}

/** Fin de rama: un nodo de una sola salida sin conexión cierra la corrida
 *  como completada y el chat queda libre para la IA. */
async function terminarFinDeRama(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
): Promise<void> {
  await logEvent(db, run.id, "completed", nodeKey, { reason: "fin_de_rama" });
  await endRun(db, run.id, "completed", "fin_de_rama");
}

/** Espera configurada de «Esperar respuesta», en segundos.
 *  Nuevo formato `espera_segundos`; los flujos viejos traen minutos. */
function esperaSegundosDe(cfg: SaveReplyNodeConfig): number {
  if (typeof cfg.espera_segundos === "number" && Number.isFinite(cfg.espera_segundos)) {
    return Math.min(Math.max(cfg.espera_segundos, 0), ESPERA_MAX_SEGUNDOS);
  }
  const minutos = Number(cfg.espera_minutos);
  if (!Number.isFinite(minutos)) return 0;
  return Math.min(Math.max(minutos * 60, 0), ESPERA_MAX_SEGUNDOS);
}

/** Ventana del buffer de mensajes, en segundos (0 = apagado). */
function segundosBuffer(cfg: SaveReplyNodeConfig): number {
  const n = Number(cfg.buffer_segundos);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, BUFFER_MAX_SEGUNDOS);
}

/** Buffer en curso de este nodo, si lo hay. */
export function leerBuffer(
  vars: Record<string, unknown> | null | undefined,
  nodeKey: string,
): BufferRespuesta | null {
  const b = (vars ?? {})[VAR_BUFFER] as BufferRespuesta | undefined;
  if (!b || b.nodo !== nodeKey || !Array.isArray(b.textos)) return null;
  return b;
}

/** wamid a citar en el próximo envío (no lo consume). */
function leerReplyTo(run: FlowRunRow): string | null {
  const v = (run.vars ?? {})[VAR_REPLY_TO];
  return typeof v === "string" && v ? v : null;
}

/** Marca la cita como usada, para que solo aplique al siguiente envío. */
async function limpiarReplyTo(db: AdminClient, run: FlowRunRow): Promise<void> {
  if (!run.vars || !(VAR_REPLY_TO in run.vars)) return;
  delete run.vars[VAR_REPLY_TO];
  await db
    .from("flow_runs")
    .update({ vars: run.vars })
    .eq("id", run.id)
    .eq("transition_seq", run.transition_seq ?? 0);
}

/** Reacción 👍 al mensaje de la clienta. Cosmética: nunca frena el flujo. */
async function reaccionarAlMensaje(
  db: AdminClient,
  run: FlowRunRow,
  messageId: string | null | undefined,
): Promise<void> {
  if (!messageId || !run.contact_id) return;
  try {
    await engineSendReaction({
      accountId: run.account_id,
      contactId: run.contact_id,
      targetMessageId: messageId,
      emoji: "👍",
    });
  } catch (err) {
    console.warn(
      "[flows] no se pudo reaccionar 👍:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Guarda el texto capturado en el contacto. Los campos personalizados se
 * codifican `custom:<id>`; los base admitidos son name/email/company
 * (teléfono no: cambiaría el destino de los envíos).
 */
async function guardarEnContacto(
  db: AdminClient,
  run: FlowRunRow,
  campo: string,
  valor: string,
): Promise<void> {
  if (!campo || !run.contact_id) return;
  try {
    if (campo.startsWith("custom:")) {
      const fieldId = campo.slice("custom:".length);
      if (!fieldId) return;
      const { data: field } = await db
        .from("custom_fields")
        .select("id")
        .eq("id", fieldId)
        .eq("account_id", run.account_id)
        .maybeSingle();
      if (!field) return;
      await db.from("contact_custom_values").upsert(
        { contact_id: run.contact_id, custom_field_id: fieldId, value: valor },
        { onConflict: "contact_id,custom_field_id" },
      );
      return;
    }
    if (!["name", "email", "company"].includes(campo)) return;
    await db
      .from("contacts")
      .update({ [campo]: valor })
      .eq("id", run.contact_id)
      .eq("account_id", run.account_id);
  } catch (err) {
    console.warn(
      "[flows] no se pudo guardar el campo del contacto:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Cierra una corrida en «Esperar indefinidamente» que llegó a su válvula
 * de 31 días. No manda nada: fuera de la ventana de 24 h sería rechazo.
 */
async function cerrarEsperaIndefinida(
  db: AdminClient,
  runId: string,
  nodeKey: string | null,
): Promise<boolean> {
  const { data } = await db
    .from("flow_runs")
    .update({
      status: "completed",
      ended_at: new Date().toISOString(),
      end_reason: "espera_indefinida_vencida",
      next_run_at: null,
      resume_reason: null,
    })
    .eq("id", runId)
    .eq("status", "active")
    .eq("resume_reason", "awaiting_reply")
    .select("id");
  if (!Array.isArray(data) || data.length !== 1) return false;
  await logEvent(db, runId, "completed", nodeKey, {
    reason: "espera_indefinida_vencida",
  });
  return true;
}

function dormir(segundos: number): Promise<void> {
  // En las pruebas no se espera de verdad (mismo criterio que mostrarEscribiendo).
  if (segundos <= 0 || process.env.NODE_ENV === "test") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, segundos * 1000));
}

function acotar(valor: unknown, min: number, max: number, defecto: number): number {
  if (valor === undefined || valor === null || valor === "") return defecto;
  const n = Number(valor);
  if (!Number.isFinite(n)) return defecto;
  return Math.min(Math.max(n, min), max);
}

/** Cursor de un Mensaje compuesto estacionado, si pertenece a este nodo. */
export function leerCursorBurbuja(
  vars: Record<string, unknown> | null | undefined,
  nodeKey: string,
): number | null {
  const c = (vars ?? {})[VAR_CURSOR_BURBUJA] as { nodo?: unknown; i?: unknown } | undefined;
  if (!c || c.nodo !== nodeKey) return null;
  const i = Number(c.i);
  return Number.isInteger(i) && i >= 0 ? i : null;
}

function varsSinCursor(vars: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const copia = { ...(vars ?? {}) };
  delete copia[VAR_CURSOR_BURBUJA];
  return copia;
}

/**
 * Manda las burbujas de un Mensaje compuesto desde `desde`, en orden.
 *
 * Cada burbuja: 👍 opcional al último mensaje de la clienta →
 * «escribiendo…» durante sus segundos → envío. Un «intervalo» es una
 * pausa sin «escribiendo…». Si una espera pasa de 15 s, la corrida se
 * estaciona como el Smart Delay (`resume_reason: 'delay'`) con el
 * cursor en `vars.__burbuja`, y el cron la retoma en esa misma burbuja
 * sin volver a esperar (`retomada`).
 */
async function ejecutarBurbujas(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  desde: number,
  retomada: boolean,
): Promise<"ok" | "estacionada" | "fallo"> {
  const items = ((node.config as unknown as SendMessageNodeConfig).items ?? []) as BurbujaMensaje[];
  // Cita pendiente de «Esperar respuesta»: se gasta en la primera burbuja.
  let replyTo = leerReplyTo(run);

  const estacionar = async (i: number, segundos: number): Promise<"estacionada"> => {
    const vars = { ...(run.vars ?? {}), [VAR_CURSOR_BURBUJA]: { nodo: node.node_key, i } };
    const ok = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key, {
      next_run_at: new Date(Date.now() + segundos * 1000).toISOString(),
      resume_reason: "delay",
      vars,
    });
    if (ok) {
      run.vars = vars;
      run.current_node_key = node.node_key;
      // Retoma puntual del intervalo; el cron de 10 min sigue de respaldo.
      programarReanudarDelay(db, run.id, segundos);
    } else {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "lost_race_during_advance",
      });
    }
    return "estacionada";
  };

  for (let i = desde; i < items.length; i += 1) {
    const b = items[i] ?? ({ tipo: "text" } as BurbujaMensaje);
    const yaEsperada = retomada && i === desde;

    if (b.tipo === "interval") {
      if (yaEsperada) continue;
      const segundos = acotar(b.segundos, 0, WAIT_MAX_SEGUNDOS, 0);
      if (segundos > WAIT_INLINE_MAX_SEGUNDOS) return estacionar(i, segundos);
      await dormir(segundos);
      continue;
    }

    const esTexto = b.tipo === "text";
    const texto = (b.text ?? "").trim();
    if (esTexto ? !texto : !b.media_url?.trim()) {
      // Burbuja vacía (el validador ya la marca): se salta sin romper la corrida.
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "burbuja_vacia",
        burbuja: i,
      });
      continue;
    }

    if (!yaEsperada) {
      const wamid = await wamidEntrante(db, run.conversation_id);
      if (b.like && wamid) {
        try {
          await engineSendReaction({
            accountId: run.account_id,
            contactId: run.contact_id!,
            targetMessageId: wamid,
            emoji: "👍",
          });
        } catch (err) {
          console.warn("[flows] no se pudo reaccionar 👍:", err instanceof Error ? err.message : err);
        }
      }
      const segundos = acotar(
        b.segundos,
        0,
        BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS,
        BURBUJA_ESCRIBIENDO_DEFECTO,
      );
      if (segundos > 0) {
        try {
          await mostrarEscribiendo({ accountId: run.account_id, messageId: wamid, esperar: false });
        } catch {
          // Cosmético: nunca frena el envío.
        }
      }
      if (segundos > WAIT_INLINE_MAX_SEGUNDOS) return estacionar(i, segundos);
      await dormir(segundos);
    }

    try {
      const { whatsapp_message_id } = esTexto
        ? await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: interpolateVars(texto, run.vars),
            ...(replyTo ? { contextMessageId: replyTo } : {}),
          })
        : await engineSendMedia({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            kind: b.tipo as "image" | "video" | "audio" | "document" | "sticker",
            link: interpolateVars(b.media_url!, run.vars),
            caption:
              b.text?.trim() && b.tipo !== "audio" && b.tipo !== "sticker"
                ? interpolateVars(b.text, run.vars)
                : undefined,
            filename: b.tipo === "document" ? b.filename : undefined,
            ...(replyTo ? { contextMessageId: replyTo } : {}),
          });
      // La cita aplica al primer mensaje de la secuencia, no a todas.
      if (replyTo) {
        await limpiarReplyTo(db, run);
        replyTo = null;
      }
      await logEvent(db, run.id, "message_sent", node.node_key, {
        node_type: "send_message",
        burbuja: i,
        tipo: b.tipo,
        whatsapp_message_id,
      });
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "send_bubble_failed",
        burbuja: i,
        tipo: b.tipo,
        detail: err instanceof Error ? err.message : String(err),
      });
      await endRun(db, run.id, "failed", "send_bubble_failed");
      return "fallo";
    }
  }
  return "ok";
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  await sumarVariablesGlobales(db, run);
  let currentKey: string | null = startNodeKey;
  // Último nodo ejecutado: decide si una salida vacía es un fin de rama
  // limpio o un error.
  let anterior: FlowNodeRow | null = null;
  for (let safety = 0; safety < MAX_NODES_PER_ADVANCE; safety += 1) {
    if (!currentKey && anterior && NODOS_FIN_DE_RAMA.has(anterior.node_type)) {
      await terminarFinDeRama(db, run, anterior.node_key);
      return { outcome: "completed" };
    }
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });
    anterior = node;

    // Texto que se va a mandar en este paso: sirve para calcular cuánto
    // tarda «escribiendo…» (a más texto, más tiempo).
    const textoDelNodo =
      typeof (node.config as { text?: unknown }).text === "string"
        ? ((node.config as { text: string }).text ?? "")
        : typeof (node.config as { caption?: unknown }).caption === "string"
          ? ((node.config as { caption: string }).caption ?? "")
          : typeof (node.config as { body_text?: unknown }).body_text === "string"
            ? ((node.config as { body_text: string }).body_text ?? "")
            : "";

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      if (Array.isArray(cfg.items) && cfg.items.length > 0) {
        // Mensaje compuesto: las burbujas salen en orden dentro del nodo.
        const r = await ejecutarBurbujas(db, run, node, 0, false);
        if (r === "estacionada") return { outcome: "advanced" };
        if (r === "fallo") return { outcome: "completed" };
        currentKey = cfg.next_node_key;
        continue;
      }
      try {
        await ritmoHumano(db, run, textoDelNodo);
        const replyTo = leerReplyTo(run);
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
          ...(replyTo ? { contextMessageId: replyTo } : {}),
        });
        if (replyTo) await limpiarReplyTo(db, run);
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        await ritmoHumano(db, run, textoDelNodo);
        const replyTo = leerReplyTo(run);
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: interpolateVars(cfg.media_url, run.vars),
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
          ...(replyTo ? { contextMessageId: replyTo } : {}),
        });
        if (replyTo) await limpiarReplyTo(db, run);
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "wait") {
      // Smart Delay. Hasta 15 s se espera dentro del mismo avance; más
      // que eso, la corrida se estaciona con `next_run_at` y el cron de
      // cada minuto la retoma (resumeDueRuns). Tope: 23 h para el modo
      // intervalo; 31 días para fecha/horario.
      const cfg = node.config as unknown as WaitNodeConfig;
      const modo = cfg.modo ?? "intervalo";
      let segundos = 0;
      if (modo === "fecha" || modo === "horario") {
        const { data: cuenta } = await db
          .from("accounts")
          .select("timezone, business_hours")
          .eq("id", run.account_id)
          .maybeSingle();
        const timeZone =
          (cuenta as { timezone?: string } | null)?.timezone ||
          "America/Mexico_City";
        let horario = cfg.horario;
        if (modo === "horario" && (horario?.usar_cuenta ?? true)) {
          const bh = (cuenta as {
            business_hours?: {
              enabled?: boolean;
              days?: number[];
              start?: string;
              end?: string;
              dias?: number[];
              desde?: string;
              hasta?: string;
            };
          } | null)?.business_hours;
          const fuente = (bh && bh.enabled !== false ? bh : horario) as
            | {
                days?: number[];
                start?: string;
                end?: string;
                dias?: number[];
                desde?: string;
                hasta?: string;
              }
            | undefined;
          horario = {
            timezone: timeZone,
            usar_cuenta: true,
            dias: fuente?.days ?? fuente?.dias ?? [1, 2, 3, 4, 5],
            desde: fuente?.start ?? fuente?.desde ?? "09:00",
            hasta: fuente?.end ?? fuente?.hasta ?? "18:00",
          };
        }
        const calculado = esperaProgramadaSegundos({
          modo,
          fecha_objetivo: cfg.fecha_objetivo,
          horario,
          timeZonePorDefecto: timeZone,
          now: new Date(),
        });
        if (calculado === null) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "wait_schedule_invalid",
            modo,
          });
          await endRun(db, run.id, "failed", "wait_schedule_invalid");
          return { outcome: "completed" };
        }
        segundos = Math.min(calculado, WAIT_PROGRAMADO_MAX_SEGUNDOS);
      } else {
        segundos = Math.min(
          Math.max(Number(cfg.segundos) || 0, 0),
          WAIT_MAX_SEGUNDOS,
        );
      }
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "wait",
        modo,
        seconds: segundos,
      });
      if (segundos > WAIT_INLINE_MAX_SEGUNDOS) {
        const estacionada = await advanceCurrentNodeKey(
          db,
          run.id,
          run.current_node_key,
          node.node_key,
          {
            next_run_at: new Date(Date.now() + segundos * 1000).toISOString(),
            resume_reason: "delay",
          },
        );
        if (!estacionada) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "lost_race_during_advance",
          });
        } else {
          // Retoma puntual; el cron de 10 min sigue de respaldo.
          programarReanudarDelay(db, run.id, segundos);
        }
        return { outcome: "advanced" };
      }
      if (segundos > 0) {
        await new Promise((resolve) => setTimeout(resolve, segundos * 1000));
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "meta_capi") {
      // Evento de Meta CAPI ligado al clic del anuncio. Nunca frena el
      // flujo: si no hay anuncio o Meta lo rechaza, se anota y sigue.
      const cfg = node.config as unknown as MetaCapiNodeConfig;
      const valor =
        cfg.value_mode === "variable" && cfg.value_var
          ? Number(interpolateVars(`{{vars.${cfg.value_var}}}`, run.vars)) || 0
          : cfg.value;
      const pageId = cfg.page_id
        ? interpolateVars(cfg.page_id, run.vars)
        : undefined;
      const resultado = await enviarEventoMeta({
        accountId: run.account_id,
        contactId: run.contact_id!,
        conversationId: run.conversation_id,
        eventName: cfg.event_name,
        // Un evento por nodo y corrida: Meta deduplica con este id.
        eventId: `${run.id}-${node.node_key}`,
        value: valor,
        currency: cfg.currency,
        pixelId: cfg.pixel_id,
        pageId,
      });
      await logEvent(
        db,
        run.id,
        resultado.enviado ? "node_entered" : "error",
        node.node_key,
        resultado.enviado
          ? { node_type: "meta_capi", event_name: cfg.event_name, enviado: true }
          : {
              node_type: "meta_capi",
              event_name: cfg.event_name,
              reason: `meta_capi_${resultado.motivo}`,
            },
      );
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_template") {
      // Plantilla aprobada por Meta, con {{n}} rellenadas desde el
      // contacto / el flujo. Pasa por la capa de seguridad de siempre
      // (incluido el tope diario de plantillas).
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      try {
        const datos = await cargarDatosFichas(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          vars: run.vars,
          textos: Object.values(cfg.variables ?? {}),
        });
        const params = parametrosDePlantilla(cfg.variables, datos);
        await ritmoHumano(db, run);
        const { whatsapp_message_id } = await engineSendTemplate({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          templateName: cfg.template_name,
          language: cfg.language,
          params,
          reason: "flow_send_template",
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_template",
          template: cfg.template_name,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_template_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "move_kanban") {
      // Mueve (o crea) el trato del contacto en el tablero. Si falla, se
      // anota y el flujo sigue: el Kanban no debe dejar a nadie sin respuesta.
      const cfg = node.config as unknown as MoveKanbanNodeConfig;
      try {
        const datos = await cargarDatosFichas(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          vars: run.vars,
          textos: [cfg.titulo || "{{contact.name}}"],
        });
        const r = await moverContactoEnKanban(db, {
          accountId: run.account_id,
          userId: run.user_id,
          contactId: run.contact_id!,
          conversationId: run.conversation_id,
          pipelineId: cfg.pipeline_id,
          stageId: cfg.stage_id,
          crear: cfg.crear_si_no_existe !== false,
          titulo: sustituirFichas(cfg.titulo || "{{contact.name}}", datos).trim(),
        });
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "move_kanban",
          accion: r.accion,
          deal_id: r.dealId,
        });
        // Mismo disparador que mover la tarjeta a mano en el tablero.
        if (r.dealId && (r.accion === "movido" || r.accion === "creado")) {
          await runAutomationsForTrigger({
            accountId: run.account_id,
            triggerType: "deal_stage_changed",
            contactId: run.contact_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              deal_id: r.dealId,
              pipeline_id: cfg.pipeline_id,
              stage_id: cfg.stage_id,
              from_stage_id: r.desdeEtapa ?? undefined,
            },
          }).catch((err) => {
            console.error("[flows] deal_stage_changed falló:", err);
            return 0;
          });
        }
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "move_kanban_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_payment") {
      // Manda los datos SPEI y se queda esperando el comprobante.
      const cfg = node.config as unknown as SendPaymentNodeConfig;
      const datos = await datosPagoDelNodo(db, run.account_id, cfg);
      if (!datos.clabe || !(datos.monto > 0)) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "pago_sin_clabe_o_monto",
        });
        await endRun(db, run.id, "failed", "pago_sin_clabe_o_monto");
        return { outcome: "completed" };
      }
      const texto = textoPagoSpei(datos, cfg.mensaje);
      try {
        await ritmoHumano(db, run, texto);
        const { whatsapp_message_id } = cfg.con_boton
          ? await engineSendInteractiveButtons({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              bodyText: texto,
              buttons: BOTONES_PAGO.map((b) => ({ id: b.reply_id, title: b.title })),
            })
          : await engineSendText({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              text: texto,
            });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_payment",
          con_boton: Boolean(cfg.con_boton),
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_payment_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_payment_failed");
        return { outcome: "completed" };
      }
      const esperaMin = Math.min(Math.max(Number(cfg.espera_minutos) || 0, 1), 23 * 60);
      const avanzado = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
        {
          next_run_at: new Date(Date.now() + esperaMin * 60_000).toISOString(),
          resume_reason: "payment_timeout",
        },
      );
      if (!avanzado) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "save_reply") {
      // Manda el mensaje (si lo hay) y se queda esperando. La respuesta
      // la captura handleReplyForActiveRun; si no llega, el cron la
      // manda por la salida de «no contesta».
      const cfg = node.config as unknown as SaveReplyNodeConfig;
      if (cfg.prompt_text && cfg.prompt_text.trim()) {
        try {
          await ritmoHumano(db, run, textoDelNodo);
          const { whatsapp_message_id } = await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: interpolateVars(cfg.prompt_text, run.vars),
          });
          await logEvent(db, run.id, "message_sent", node.node_key, {
            node_type: "save_reply",
            whatsapp_message_id,
          });
        } catch (err) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "save_reply_prompt_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
          await endRun(db, run.id, "failed", "save_reply_prompt_failed");
          return { outcome: "completed" };
        }
      }
      // «Indefinido» no tiene salida por timeout: `awaiting_reply` con
      // una válvula a 31 días que cierra la corrida sin mandar nada.
      const indefinido = Boolean(cfg.esperar_indefinido);
      const esperaSeg = indefinido ? ESPERA_MAX_SEGUNDOS : esperaSegundosDe(cfg);
      const avanzado = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
        esperaSeg > 0
          ? {
              next_run_at: new Date(Date.now() + esperaSeg * 1000).toISOString(),
              resume_reason: indefinido ? "awaiting_reply" : "reply_timeout",
            }
          : {},
      );
      if (!avanzado) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "connect_flow") {
      const cfg = node.config as unknown as ConnectFlowNodeConfig;
      try {
        const outcome = await transferirAFlujo(db, run, cfg.target_flow_id);
        return { outcome };
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "connect_flow_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "completed", "connect_flow_failed");
        return { outcome: "completed" };
      }
    }
    if (node.node_type === "ai_block") {
      const cfg = node.config as unknown as AiBlockNodeConfig;
      let next = cfg.fallback_next;
      try {
        next = await ejecutarAiBlock(db, run, cfg);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "ai_block_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "ai_block",
        advancing_to: next,
      });
      continue;
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      const ids = cfg.tag_ids?.length
        ? cfg.tag_ids
        : cfg.tag_id
          ? [cfg.tag_id]
          : [];
      try {
        for (const tagId of ids) {
          if (cfg.mode === "add") {
            await addContactTagAndDispatch({
              db,
              accountId: run.account_id,
              contactId: run.contact_id!,
              tagId,
              context: {
                conversation_id: run.conversation_id ?? undefined,
                vars: run.vars,
              },
            });
          } else {
            await removeContactTag(db, {
              accountId: run.account_id,
              contactId: run.contact_id!,
              tagId,
            });
          }
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "manipulator") {
      const cfg = node.config as unknown as ManipulatorNodeConfig;
      await ejecutarManipulador(db, run, node);
      currentKey = cfg.next_node_key;
      await logEvent(db, run.id, "node_entered", node.node_key, { node_type: "manipulator" });
      continue;
    }
    if (node.node_type === "distributor") {
      currentKey = await elegirDistribuidor(db, run, node);
      await logEvent(db, run.id, "node_entered", node.node_key, { node_type: "distributor", advancing_to: currentKey });
      continue;
    }
    if (node.node_type === "notification") {
      const cfg = node.config as unknown as NotificationNodeConfig;
      await enviarNotificacion(db, run, node).catch((err) => logEvent(db, run.id, "error", node.node_key, { reason: "notification_failed", detail: err instanceof Error ? err.message : String(err) }));
      currentKey = cfg.next_node_key ?? "";
      continue;
    }
    if (node.node_type === "sale_approved") {
      const cfg = node.config as unknown as SaleApprovedNodeConfig;
      await registrarVentaAprobada(db, run, node);
      currentKey = cfg.next_node_key ?? "";
      await logEvent(db, run.id, "node_entered", node.node_key, { node_type: "sale_approved" });
      continue;
    }
    if (node.node_type === "carousel") {
      const outcome = await ejecutarCarrusel(db, run, node);
      return { outcome };
    }
    if (node.node_type === "department") {
      const cfg = node.config as unknown as DepartmentNodeConfig;
      if (run.conversation_id && cfg.department_id) {
        const { data: dep } = await db
          .from("departments")
          .select("id, name")
          .eq("id", cfg.department_id)
          .eq("account_id", run.account_id)
          .maybeSingle();
        if (dep) {
          await db
            .from("conversations")
            .update({
              department_id: (dep as { id: string }).id,
              updated_at: new Date().toISOString(),
            })
            .eq("id", run.conversation_id)
            .eq("account_id", run.account_id);
        } else {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "department_not_found",
            department_id: cfg.department_id,
          });
        }
      }
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "department",
        department_id: cfg.department_id,
      });
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "http_request") {
      const cfg = node.config as unknown as HttpRequestNodeConfig;
      try {
        const r = await ejecutarHttpRequest(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          vars: run.vars,
          cfg,
        });
        const vars: Record<string, unknown> = { ...run.vars, ...r.mapped };
        if (cfg.status_var?.trim()) vars[cfg.status_var.trim()] = String(r.status);
        run.vars = vars;
        await db
          .from("flow_runs")
          .update({ vars })
          .eq("id", run.id)
          .eq("transition_seq", run.transition_seq ?? 0);
        await logEvent(db, run.id, r.ok ? "node_entered" : "error", node.node_key, {
          node_type: "http_request",
          method: cfg.method,
          status: r.status,
          duration_ms: r.duration_ms,
          mapped_keys: Object.keys(r.mapped),
        });
        if (!r.ok) {
          if (cfg.error_next) currentKey = cfg.error_next;
          else if (cfg.continue_on_error === false) {
            await endRun(db, run.id, "failed", "http_request_failed");
            return { outcome: "completed" };
          } else currentKey = cfg.next_node_key;
        } else {
          currentKey = cfg.next_node_key;
        }
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "http_request_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        if (cfg.continue_on_error === false) {
          await endRun(db, run.id, "failed", "http_request_failed");
          return { outcome: "completed" };
        }
        currentKey = cfg.error_next || cfg.next_node_key;
      }
      continue;
    }
    if (node.node_type === "ai_media") {
      const cfg = node.config as unknown as AiMediaNodeConfig;
      try {
        const media = await generarMediaIA(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          vars: run.vars,
          cfg,
        });
        const varKey = cfg.output_var?.trim() || "ai_media_url";
        run.vars = { ...run.vars, [varKey]: media.url };
        await db
          .from("flow_runs")
          .update({ vars: run.vars })
          .eq("id", run.id)
          .eq("transition_seq", run.transition_seq ?? 0);
        if (cfg.send_now) {
          await engineSendMedia({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            kind: media.kind,
            link: media.url,
          }).catch((err) =>
            logEvent(db, run.id, "error", node.node_key, {
              reason: "ai_media_send_failed",
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "ai_media",
          kind: media.kind,
          provider: media.provider,
          var_key: varKey,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "ai_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "payment_gateway") {
      const outcome = await ejecutarPasarelaPago(db, run, node);
      return { outcome };
    }
    if (node.node_type === "official_call") {
      const outcome = await ejecutarLlamadaOficial(db, run, node);
      return { outcome };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
  /** Campos extra, p. ej. `next_run_at` para estacionar la corrida. */
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      ...extra,
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function claimReplyTransition(
  db: AdminClient,
  run: FlowRunRow,
  nextNodeKey: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const fromKey = run.current_node_key;
  if (fromKey === null) return false;
  const nextSeq = (run.transition_seq ?? 0) + 1;
  const { data, error } = await db
    .from("flow_runs")
    .update({
      // Al avanzar se suelta cualquier temporizador del nodo anterior.
      next_run_at: null,
      resume_reason: null,
      ...extra,
      current_node_key: nextNodeKey,
      transition_seq: nextSeq,
      reprompt_count: 0,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (error) {
    console.error("[flows] claimReplyTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.current_node_key = nextNodeKey;
  run.transition_seq = nextSeq;
  run.reprompt_count = 0;
  return true;
}

async function closeActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  closure: ActiveRunClosure,
  now: Date,
): Promise<void> {
  if (closure.kind === "timeout") {
    await markRunTimedOut(db, run.id, closure.check, "timed_out_on_reply", now);
    return;
  }
  await endRun(
    db,
    run.id,
    closure.kind === "cancel" ? "cancelled" : "failed",
    closure.reason,
  );
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

/**
 * «Guardar respuesta» sin contestación.
 *
 * La clienta no escribió dentro del plazo: el flujo sigue por su salida
 * de «no contesta». Esto no lo puede detectar el webhook (no hay
 * mensaje entrante), así que lo llama el barrido periódico
 * (`/api/flows/cron`). Devuelve true si movió la ejecución.
 */
export async function resumeSaveReplyTimeout(
  db: AdminClient,
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data: fila } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  const run = fila as FlowRunRow | null;
  if (!run || run.status !== "active" || !run.current_node_key) return false;

  const [flow, nodes] = await Promise.all([
    loadFlow(db, run.flow_id),
    loadAllNodes(db, run.flow_id),
  ]);
  if (!flow) return false;
  const nodo = nodes.get(run.current_node_key);
  if (!nodo || nodo.node_type !== "save_reply") return false;

  const cfg = nodo.config as unknown as SaveReplyNodeConfig;
  // «Indefinido» no tiene salida por timeout: la cierra su válvula.
  if (cfg.esperar_indefinido) return false;
  // Tope de 23 h: pasado eso la conversación está fuera de la ventana de
  // 24 h de WhatsApp y un mensaje libre sería un rechazo de Meta (y una
  // señal de spam). Mejor no mandar nada.
  const espera = Math.min(esperaSegundosDe(cfg) / 60, 23 * 60);
  const minutos =
    (now.getTime() - new Date(run.last_advanced_at).getTime()) / 60_000;
  // 30 s de tolerancia: next_run_at se calcula unos milisegundos antes
  // que last_advanced_at al estacionar la corrida.
  if (!(espera > 0) || minutos < espera - 0.5) return false;
  // Sin salida «si no responde» (válido, como en Leona): se vence la
  // espera y la conversación termina aquí, en vez de quedar estacionada.
  if (!cfg.no_contesto_next) {
    await logEvent(db, run.id, "completed", nodo.node_key, { reason: "timeout_sin_salida" });
    await endRun(db, run.id, "completed", "timeout_sin_salida");
    return true;
  }
  if (await cerrarSiFueraDeVentana(db, run, nodo.node_key, now)) return true;
  if (!(await claimReplyTransition(db, run, cfg.no_contesto_next))) return false;

  await logEvent(db, run.id, "node_entered", nodo.node_key, {
    saved_key: cfg.var_key,
    sin_respuesta: true,
    via: "no_contesto",
  });
  await advanceFromNodeKey(db, run, cfg.no_contesto_next, nodes);
  return true;
}

/**
 * Cierra el buffer de mensajes de «Esperar respuesta» y avanza con todo
 * lo que escribió la clienta. Lo llaman el temporizador en proceso (para
 * que se sienta inmediato) y el barrido de 10 min como respaldo. Es
 * idempotente: `claimReplyTransition` decide quién gana.
 */
export async function resumeReplyBuffer(
  db: AdminClient,
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data: fila } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  const run = fila as FlowRunRow | null;
  if (
    !run ||
    run.status !== "active" ||
    !run.current_node_key ||
    run.resume_reason !== "reply_buffer"
  ) {
    return false;
  }
  const [flow, nodes] = await Promise.all([
    loadFlow(db, run.flow_id),
    loadAllNodes(db, run.flow_id),
  ]);
  if (!flow || flow.status !== "active") return false;
  const nodo = nodes.get(run.current_node_key);
  if (!nodo || nodo.node_type !== "save_reply") return false;
  const cfg = nodo.config as unknown as SaveReplyNodeConfig;
  const buffer = leerBuffer(run.vars, nodo.node_key);
  if (!buffer) return false;

  const textos = buffer.textos.map((t) => String(t).trim()).filter(Boolean);
  const vars: Record<string, unknown> = { ...run.vars };
  delete vars[VAR_BUFFER];
  if (textos.length === 0) {
    await db
      .from("flow_runs")
      .update({ next_run_at: null, resume_reason: null, vars })
      .eq("id", run.id)
      .eq("status", "active")
      .eq("transition_seq", run.transition_seq ?? 0);
    return false;
  }
  if (!cfg.var_key) return false;
  if (!cfg.contesto_next) {
    // Búfer con «si contesta» sin conectar: se guarda y termina (Leona).
    const guardado = { ...vars, [cfg.var_key]: textos.join(" ") };
    await db.from("flow_runs").update({ vars: guardado }).eq("id", run.id);
    await endRun(db, run.id, "completed", "contesto_sin_salida");
    return true;
  }

  const capturado = textos.join("\n");
  vars[cfg.var_key] = capturado;
  if (cfg.campo_contacto) {
    await guardarEnContacto(db, run, cfg.campo_contacto, capturado);
  }
  if (await cerrarSiFueraDeVentana(db, run, nodo.node_key, now)) return false;
  if (!(await claimReplyTransition(db, run, cfg.contesto_next, { vars }))) {
    return false;
  }
  run.vars = vars;
  await logEvent(db, run.id, "node_entered", nodo.node_key, {
    saved_key: cfg.var_key,
    saved_length: capturado.length,
    buffered: textos.length,
    via: "contesto",
  });
  await advanceFromNodeKey(db, run, cfg.contesto_next, nodes);
  return true;
}

/**
 * Temporizador en proceso para cerrar el buffer a los N segundos. El
 * cron (cada 10 min) es el respaldo si el proceso se reinicia. No
 * mantiene vivo el proceso solo por este timer.
 */
function programarResumeBuffer(
  db: AdminClient,
  runId: string,
  segundos: number,
): void {
  if (segundos <= 0 || process.env.NODE_ENV === "test") return;
  const timer = setTimeout(() => {
    void resumeReplyBuffer(db, runId).catch((err) => {
      console.error(
        "[flows] buffer de esperar respuesta:",
        err instanceof Error ? err.message : err,
      );
    });
  }, segundos * 1000) as unknown as { unref?: () => void };
  timer.unref?.();
}

/**
 * Temporizador en proceso para las esperas largas (Smart Delay e
 * intervalos del Mensaje compuesto). Antes solo las retomaba el cron de
 * 10 min, así que un delay real de 2 min podía ejecutarse a los 10. El
 * cron sigue siendo el respaldo si el proceso se reinicia.
 */
function programarReanudarDelay(
  db: AdminClient,
  runId: string,
  segundos: number,
): void {
  if (segundos <= 0 || process.env.NODE_ENV === "test") return;
  const timer = setTimeout(() => {
    void (async () => {
      const { data } = await db
        .from("flow_runs")
        .select("*")
        .eq("id", runId)
        .maybeSingle();
      const run = data as FlowRunRow | null;
      if (!run || run.status !== "active" || run.resume_reason !== "delay") {
        return;
      }
      await resumeDelay(db, run, new Date());
    })().catch((err) => {
      console.error(
        "[flows] espera larga:",
        err instanceof Error ? err.message : err,
      );
    });
  }, segundos * 1000) as unknown as { unref?: () => void };
  timer.unref?.();
}

/**
 * Ventana de 24 h: si el último mensaje de la clienta ya tiene más de
 * 23,5 h, la corrida termina sin mandar nada (un mensaje libre fuera de
 * la ventana es un rechazo de Meta y una señal de spam). Devuelve true
 * si la cerró.
 */
async function cerrarSiFueraDeVentana(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
  now: Date,
): Promise<boolean> {
  if (!run.conversation_id) return false;
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", run.conversation_id)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultima = (data as { created_at?: string } | null)?.created_at;
  if (ultima && now.getTime() - new Date(ultima).getTime() <= VENTANA_SERVICIO_MS) {
    return false;
  }
  await logEvent(db, run.id, "timeout", nodeKey, {
    reason: "fuera_de_ventana_24h",
  });
  await endRun(db, run.id, "cancelled", "fuera_de_ventana_24h");
  return true;
}

/** Datos SPEI del nodo, completando lo vacío con `payment_details`. */
async function datosPagoDelNodo(
  db: AdminClient,
  accountId: string,
  cfg: SendPaymentNodeConfig,
): Promise<DatosPago> {
  const faltaAlgo = !cfg.clabe || !cfg.beneficiario || !cfg.banco;
  let cuenta: { clabe?: string | null; holder?: string | null; bank?: string | null } | null = null;
  if (faltaAlgo) {
    const { data } = await db
      .from("payment_details")
      .select("clabe, holder, bank, activo")
      .eq("account_id", accountId)
      .maybeSingle();
    const fila = data as { clabe: string | null; holder: string | null; bank: string | null; activo: boolean } | null;
    cuenta = fila?.activo ? fila : null;
  }
  return combinarDatosPago(cfg, cuenta);
}

/**
 * Pasarela SPEI esperando comprobante: reutiliza el lector automático
 * (DeepSeek + unpdf) de `send_payment`. Si el comprobante es válido,
 * despierta la corrida por la salida «Pago aprobado».
 */
async function handleGatewayReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  message: ParsedInbound,
): Promise<DispatchInboundResult> {
  const cfg = node.config as unknown as PaymentGatewayNodeConfig;
  if (cfg.provider !== "spei") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }
  const enviar = (text: string) =>
    engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text,
    });

  if (message.kind === "interactive_reply") {
    if (BOTONES_PAGO.some((b) => b.reply_id === message.reply_id)) {
      await enviar(TEXTO_PIDE_COMPROBANTE).catch(() => undefined);
    }
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }
  if (message.kind !== "media") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  const { data: session } = await db
    .from("flow_payment_sessions")
    .select("id, reference, amount, currency, status")
    .eq("flow_run_id", run.id)
    .eq("node_key", node.node_key)
    .maybeSingle();
  if (!session || (session as { status: string }).status !== "pending") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }
  const fila = session as {
    id: string;
    reference: string;
    amount: number;
    currency: string;
    status: string;
  };

  const datos = await datosPagoDelNodo(db, run.account_id, {
    clabe: "",
    beneficiario: "",
    banco: "",
    monto: Number(fila.amount),
    referencia: fila.reference,
    mensaje: cfg.concept,
    con_boton: false,
    espera_minutos: cfg.wait_minutes,
    aprobado_next: cfg.approved_next,
    rechazado_next: cfg.rejected_next || "",
  });

  let lectura = null;
  try {
    const { accessToken } = await loadAccountMetaCredentials(db, run.account_id);
    lectura = await leerComprobanteDeMedio({
      accountId: run.account_id,
      mediaId: message.media_id,
      mime: message.mime_type,
      accessToken,
    });
  } catch (err) {
    console.warn(
      "[flows] no se pudo leer el comprobante SPEI:",
      err instanceof Error ? err.message : err,
    );
  }

  const ref = (lectura?.referencia ?? "").trim();
  let repetida = false;
  if (ref.length >= 5) {
    const { count } = await db
      .from("payment_receipts")
      .select("id", { count: "exact", head: true })
      .eq("account_id", run.account_id)
      .eq("referencia", ref)
      .eq("resultado", "aprobado");
    repetida = (count ?? 0) > 0;
  }

  let veredicto = veredictoPago(lectura, datos, repetida);
  if (veredicto.resultado === "reintentar") {
    await enviar(TEXTO_NO_ES_COMPROBANTE).catch(() => undefined);
    await logEvent(db, run.id, "fallback_fired", node.node_key, {
      reason: "no_es_comprobante",
    });
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  const registro = {
    account_id: run.account_id,
    contact_id: run.contact_id,
    flow_run_id: run.id,
    node_key: node.node_key,
    whatsapp_media_id: message.media_id,
    monto: lectura?.monto ?? null,
    ultimos_digitos: lectura?.ultimos_digitos_destino ?? null,
    banco_destino: lectura?.banco_destino ?? null,
    referencia: ref || null,
    estado: lectura?.estado ?? null,
    resultado: lectura ? veredicto.resultado : "revisar",
    motivos: veredicto.motivos,
  };
  const { error: insErr } = await db.from("payment_receipts").insert(registro);
  if (insErr && veredicto.resultado === "aprobado") {
    veredicto = {
      resultado: "rechazado",
      motivos: [`no se pudo registrar (posible referencia repetida): ${insErr.message}`],
    };
    await db
      .from("payment_receipts")
      .insert({ ...registro, resultado: "rechazado", motivos: veredicto.motivos });
  }

  const aprobado = veredicto.resultado === "aprobado";
  await db
    .from("flow_payment_sessions")
    .update({
      status: aprobado ? "approved" : "rejected",
      external_id: message.media_id,
      approved_at: aprobado ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", fila.id);

  if (aprobado) {
    if (lectura?.monto) {
      await guardarValor(
        run.account_id,
        run.user_id,
        run.contact_id!,
        "monto_pagado",
        String(lectura.monto),
      ).catch(() => undefined);
    }
    const etiqueta = (cfg.etiqueta_al_aprobar ?? "pagado").trim();
    if (etiqueta) {
      await etiquetar(run.account_id, run.user_id, run.contact_id!, etiqueta).catch(
        (err) => console.error("[flows] no se pudo etiquetar el pago:", err),
      );
    }
  }

  await logEvent(db, run.id, "node_entered", node.node_key, {
    node_type: "payment_gateway",
    provider: "spei",
    resultado: veredicto.resultado,
    motivos: veredicto.motivos,
  });

  await resumePaymentGateway(db, {
    runId: run.id,
    decision: aprobado ? "approved" : "rejected",
    sessionId: fila.id,
  });
  return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
}

/**
 * Botón Pago / SPEI esperando el comprobante: qué hacer con lo que
 * mande la clienta.
 *   - imagen / PDF → la IA lo lee y se valida contra ESTE nodo.
 *   - «Ya pagué» / «Tengo una duda» → se le pide el comprobante.
 *   - texto libre → el flujo sigue esperando (sigue siendo dueño).
 */
async function handlePaymentReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const cfg = node.config as unknown as SendPaymentNodeConfig;
  const enviar = (text: string) =>
    engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text,
    });

  if (message.kind === "interactive_reply") {
    if (BOTONES_PAGO.some((b) => b.reply_id === message.reply_id)) {
      await enviar(TEXTO_PIDE_COMPROBANTE).catch(() => undefined);
    }
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }
  if (message.kind !== "media") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  const datos = await datosPagoDelNodo(db, run.account_id, cfg);
  let lectura = null;
  try {
    const { accessToken } = await loadAccountMetaCredentials(db, run.account_id);
    lectura = await leerComprobanteDeMedio({
      accountId: run.account_id,
      mediaId: message.media_id,
      mime: message.mime_type,
      accessToken,
    });
  } catch (err) {
    console.warn("[flows] no se pudo leer el comprobante:", err instanceof Error ? err.message : err);
  }

  // Antifraude: ¿esta referencia ya se aprobó antes en la cuenta?
  const ref = (lectura?.referencia ?? "").trim();
  let repetida = false;
  if (ref.length >= 5) {
    const { count } = await db
      .from("payment_receipts")
      .select("id", { count: "exact", head: true })
      .eq("account_id", run.account_id)
      .eq("referencia", ref)
      .eq("resultado", "aprobado");
    repetida = (count ?? 0) > 0;
  }

  let veredicto = veredictoPago(lectura, datos, repetida);
  if (veredicto.resultado === "reintentar") {
    await enviar(TEXTO_NO_ES_COMPROBANTE).catch(() => undefined);
    await logEvent(db, run.id, "fallback_fired", node.node_key, { reason: "no_es_comprobante" });
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Registro del comprobante. El índice único de la 079 es la última
  // barrera: si otra clienta aprobó la misma referencia al mismo tiempo,
  // este insert falla y el pago se rechaza.
  const fila = {
    account_id: run.account_id,
    contact_id: run.contact_id,
    flow_run_id: run.id,
    node_key: node.node_key,
    whatsapp_media_id: message.media_id,
    monto: lectura?.monto ?? null,
    ultimos_digitos: lectura?.ultimos_digitos_destino ?? null,
    banco_destino: lectura?.banco_destino ?? null,
    referencia: ref || null,
    estado: lectura?.estado ?? null,
    resultado: lectura ? veredicto.resultado : "revisar",
    motivos: veredicto.motivos,
  };
  const { error: insErr } = await db.from("payment_receipts").insert(fila);
  if (insErr && veredicto.resultado === "aprobado") {
    veredicto = { resultado: "rechazado", motivos: [`no se pudo registrar (posible referencia repetida): ${insErr.message}`] };
    await db.from("payment_receipts").insert({ ...fila, resultado: "rechazado", motivos: veredicto.motivos });
  }

  const aprobado = veredicto.resultado === "aprobado";
  const siguiente = aprobado ? cfg.aprobado_next : cfg.rechazado_next;
  const vars = {
    ...run.vars,
    pago_resultado: aprobado ? "aprobado" : "rechazado",
    ...(lectura?.monto != null ? { pago_monto: lectura.monto } : {}),
    ...(ref ? { pago_referencia: ref } : {}),
  };
  if (!(await claimReplyTransition(db, run, siguiente, { vars }))) {
    return lostReplyRace(db, run, node.node_key);
  }
  run.vars = vars;

  const nota = lectura
    ? `🧾 Comprobante del flujo (Botón Pago / SPEI) — ${aprobado ? "✅ APROBADO" : "⚠️ RECHAZADO: " + veredicto.motivos.join("; ")}\n` +
      `Esperado: $${datos.monto} a …${datos.clabe.slice(-4)} · Leído: $${lectura.monto ?? "?"} a …${lectura.ultimos_digitos_destino ?? "?"} · ` +
      `Estado: ${lectura.estado ?? "?"} · Referencia: ${lectura.referencia ?? "?"}`
    : `🧾 Llegó un comprobante que la IA no pudo leer (${veredicto.motivos.join("; ")}). Revísalo a mano.`;
  await db.from("contact_notes").insert({
    contact_id: run.contact_id,
    user_id: run.user_id,
    account_id: run.account_id,
    note_text: nota,
  });
  await logEvent(db, run.id, "node_entered", node.node_key, {
    node_type: "send_payment",
    resultado: veredicto.resultado,
    motivos: veredicto.motivos,
  });

  if (aprobado) {
    // El monto leído alimenta la compra que se manda a Meta CAPI al
    // ponerse la etiqueta (mismo camino que el lector de siempre).
    if (lectura?.monto) {
      await guardarValor(run.account_id, run.user_id, run.contact_id!, "monto_pagado", String(lectura.monto)).catch(() => undefined);
    }
    const etiqueta = (cfg.etiqueta_al_aprobar ?? "pagado").trim();
    if (etiqueta) {
      await etiquetar(run.account_id, run.user_id, run.contact_id!, etiqueta).catch((err) =>
        console.error("[flows] no se pudo etiquetar el pago:", err),
      );
    }
  }

  if (!siguiente) {
    await endRun(db, run.id, "failed", "missing_next_node");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  const outcome = await advanceFromNodeKey(db, run, siguiente, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

/** El comprobante no llegó a tiempo: el flujo sale por Rechazado / Timeout. */
async function resumePaymentTimeout(
  db: AdminClient,
  run: FlowRunRow,
  now: Date,
): Promise<boolean> {
  if (!run.current_node_key) return false;
  const [flow, nodes] = await Promise.all([
    loadFlow(db, run.flow_id),
    loadAllNodes(db, run.flow_id),
  ]);
  const nodo = nodes.get(run.current_node_key);
  if (!flow || flow.status !== "active" || !nodo || nodo.node_type !== "send_payment") {
    await endRun(db, run.id, "cancelled", "pago_sin_flujo_activo");
    return false;
  }
  const cfg = nodo.config as unknown as SendPaymentNodeConfig;
  const vars = { ...run.vars, pago_resultado: "timeout" };
  if (!(await claimReplyTransition(db, run, cfg.rechazado_next, { vars }))) return false;
  run.vars = vars;
  if (await cerrarSiFueraDeVentana(db, run, nodo.node_key, now)) return true;
  await logEvent(db, run.id, "timeout", nodo.node_key, { node_type: "send_payment" });
  if (!cfg.rechazado_next) {
    await endRun(db, run.id, "failed", "missing_next_node");
    return true;
  }
  await advanceFromNodeKey(db, run, cfg.rechazado_next, nodes);
  return true;
}

/**
 * Cron: retoma las corridas estacionadas cuyo `next_run_at` ya venció.
 *   - 'delay'          → sigue después del Smart Delay.
 *   - 'reply_timeout'  → «Esperar respuesta» sin contestación.
 *   - 'reply_buffer'   → cierra el buffer y avanza con todo el texto.
 *   - 'awaiting_reply' → válvula de la espera indefinida: cierra limpio.
 * Seguro ante dos crons a la vez: cada corrida se reclama con
 * `transition_seq` y solo uno gana. Devuelve cuántas retomó.
 */
export async function resumeDueRuns(
  db: AdminClient,
  now: Date = new Date(),
  limite = 200,
): Promise<number> {
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limite);
  if (error) {
    console.error("[flows] resumeDueRuns:", error.message);
    return 0;
  }
  let retomadas = 0;
  for (const run of (data ?? []) as FlowRunRow[]) {
    try {
      if (run.resume_reason === "reply_timeout") {
        if (await resumeSaveReplyTimeout(db, run.id, now)) {
          retomadas += 1;
        } else {
          // Ya no aplica (el nodo cambió o alguien se adelantó): se suelta
          // el temporizador para no volver a leerla cada minuto.
          await db
            .from("flow_runs")
            .update({ next_run_at: null, resume_reason: null })
            .eq("id", run.id)
            .eq("status", "active")
            .eq("transition_seq", run.transition_seq ?? 0);
        }
        continue;
      }
      if (run.resume_reason === "reply_buffer") {
        if (await resumeReplyBuffer(db, run.id, now)) {
          retomadas += 1;
        } else {
          // El buffer ya no aplica: se suelta para no releerla cada barrido.
          await db
            .from("flow_runs")
            .update({ next_run_at: null, resume_reason: null })
            .eq("id", run.id)
            .eq("status", "active")
            .eq("transition_seq", run.transition_seq ?? 0);
        }
        continue;
      }
      if (run.resume_reason === "awaiting_reply") {
        if (await cerrarEsperaIndefinida(db, run.id, run.current_node_key)) {
          retomadas += 1;
        }
        continue;
      }
      if (run.resume_reason === "carousel_timeout") {
        if (await resumeCarouselTimeout(db, run.id, now)) retomadas += 1;
        continue;
      }
      if (run.resume_reason === "payment_timeout") {
        if (await resumePaymentTimeout(db, run, now)) retomadas += 1;
        continue;
      }
      if (run.resume_reason === "payment_gateway") {
        if (await resumePaymentGatewayTimeout(db, run)) retomadas += 1;
        continue;
      }
      if (run.resume_reason === "call_permission") {
        if (await resumeCallPermissionTimeout(db, run)) retomadas += 1;
        continue;
      }
      if (await resumeDelay(db, run, now)) retomadas += 1;
    } catch (err) {
      console.error(
        "[flows] resumeDueRuns falló en una corrida:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return retomadas;
}

async function resumeDelay(
  db: AdminClient,
  run: FlowRunRow,
  now: Date,
): Promise<boolean> {
  if (!run.current_node_key) return false;
  const [flow, nodes] = await Promise.all([
    loadFlow(db, run.flow_id),
    loadAllNodes(db, run.flow_id),
  ]);
  const nodo = nodes.get(run.current_node_key);
  // Mensaje compuesto estacionado a media secuencia (escribiendo/intervalo > 15 s).
  const cursor = nodo ? leerCursorBurbuja(run.vars, nodo.node_key) : null;
  const esMensaje = nodo?.node_type === "send_message" && cursor !== null;
  if (
    !flow ||
    flow.status !== "active" ||
    !nodo ||
    (nodo.node_type !== "wait" && !esMensaje)
  ) {
    // El flujo se pausó o se editó mientras esperaba: se cierra limpio.
    await endRun(db, run.id, "cancelled", "delay_sin_flujo_activo");
    return false;
  }
  // Reclamo atómico: suelta el temporizador solo si nadie se adelantó.
  const nextSeq = (run.transition_seq ?? 0) + 1;
  const varsLimpias = esMensaje ? varsSinCursor(run.vars) : null;
  const { data: reclamada } = await db
    .from("flow_runs")
    .update({
      next_run_at: null,
      resume_reason: null,
      transition_seq: nextSeq,
      last_advanced_at: now.toISOString(),
      ...(varsLimpias ? { vars: varsLimpias } : {}),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (!Array.isArray(reclamada) || reclamada.length !== 1) return false;
  run.transition_seq = nextSeq;
  if (varsLimpias) run.vars = varsLimpias;
  if (nodo.node_type === "wait") {
    const cfgWait = nodo.config as unknown as WaitNodeConfig;
    if (
      cfgWait.fuera_ventana_next &&
      !(await ventanaServicioAbierta(db, run.conversation_id))
    ) {
      await logEvent(db, run.id, "timeout", nodo.node_key, {
        node_type: "wait",
        reason: "fuera_de_ventana_24h",
        advancing_to: cfgWait.fuera_ventana_next,
      });
      await advanceFromNodeKey(db, run, cfgWait.fuera_ventana_next, nodes);
      return true;
    }
  }
  if (await cerrarSiFueraDeVentana(db, run, nodo.node_key, now)) return true;
  await logEvent(db, run.id, "node_entered", nodo.node_key, {
    node_type: nodo.node_type,
    delay_vencido: true,
    ...(esMensaje ? { burbuja: cursor } : {}),
  });
  if (esMensaje) {
    const r = await ejecutarBurbujas(db, run, nodo, cursor!, true);
    if (r !== "ok") return true;
  }
  const next = (nodo.config as { next_node_key?: string }).next_node_key;
  if (!next) {
    // Espera o Mensaje sin conexión: fin de rama, no error.
    await terminarFinDeRama(db, run, nodo.node_key);
    return true;
  }
  await advanceFromNodeKey(db, run, next, nodes);
  return true;
}

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  let ownedRunId: string | null = null;
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      ownedRunId = activeRun.id;
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // Palabra clave de OTRO flujo (anuncio de otro producto): cierra el
      // embudo en curso y arranca el de esa palabra, como en Leona.
      if (input.connectionId) {
        const otro = await flujoPorPalabraClaveDelNumero(
          db,
          input.accountId,
          input.connectionId,
          entryTriggerTexts(input.message),
        );
        if (otro && otro.id !== activeRun.flow_id && otro.entry_node_id) {
          await endRun(db, activeRun.id, "cancelled", "palabra_clave_otro_flujo");
          ownedRunId = null;
          const nodosOtro = await loadAllNodes(db, otro.id);
          const respuestaOtro = await startNewRun(db, otro, input, nodosOtro);
          return { ...respuestaOtro, flow: otro };
        }
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const [runFlow, nodes] = await Promise.all([
        loadFlow(db, activeRun.flow_id),
        loadAllNodes(db, activeRun.flow_id),
      ]);
      const now = new Date();
      const closure = closureForActiveRun({
        run: activeRun,
        flow: runFlow,
        nodeKeys: nodes,
        now,
      });
      if (!closure) {
        const respuesta = await handleReplyForActiveRun(
          db,
          activeRun,
          runFlow!,
          input.message,
          nodes,
        );
        return { ...respuesta, flow: runFlow ?? undefined };
      }
      await closeActiveRun(db, activeRun, closure, now);
      ownedRunId = null;
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.contactId,
      input.message,
      input.isFirstInboundMessage,
      input.connectionId ?? null,
      Boolean(input.isReopenedConversation),
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    const respuesta = await startNewRun(db, flow, input, nodes);
    return { ...respuesta, flow };
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    if (ownedRunId) {
      return { consumed: true, flow_run_id: ownedRunId, outcome: "run_error" };
    }
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  const currentNode = nodes.get(run.current_node_key!)!;

  // Permiso oficial de llamada: la respuesta no es un botón normal y
  // solo la entiende el bloque `official_call`.
  if (currentNode.node_type === "official_call" && message.kind === "call_permission") {
    return handleCallPermissionReply(db, run, currentNode, message, nodes);
  }
  if (currentNode.node_type === "payment_gateway") {
    return handleGatewayReply(db, run, currentNode, message);
  }

  // Smart Delay en curso: el flujo sigue siendo dueño de la
  // conversación. El mensaje queda registrado, no cuenta como respuesta
  // equivocada y nadie más contesta (ni la IA): la corrida sigue cuando
  // venza su espera. Lo mismo mientras se espera un pago o un permiso
  // de llamada.
  if (
    currentNode.node_type === "wait" ||
    currentNode.node_type === "official_call" ||
    (currentNode.node_type === "send_message" &&
      leerCursorBurbuja(run.vars, currentNode.node_key) !== null)
  ) {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Botón Pago / SPEI esperando el comprobante.
  if (currentNode.node_type === "send_payment") {
    return handlePaymentReply(db, run, currentNode, message, nodes);
  }

  // Para cualquier otro nodo, una imagen o documento cuenta como texto
  // con su pie de foto: exactamente lo que el flujo recibía antes de la 079.
  if (message.kind === "media") {
    message = { kind: "text", text: message.text, meta_message_id: message.meta_message_id };
  }

  // Carrusel: el clic de un botón enruta a su salida.
  const replyId = message.kind === "interactive_reply" ? message.reply_id : null;
  if (currentNode.node_type === "carousel" && replyId) {
    const cfg = currentNode.config as unknown as CarouselNodeConfig;
    let destino: string | undefined;
    for (const card of cfg.cards ?? []) {
      for (const button of card.buttons ?? []) {
        if (`car_${card.id}_${button.id}` === replyId) {
          destino = button.next_node_key;
        }
      }
    }
    if (destino) {
      if (!(await claimReplyTransition(db, run, destino))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        via: "contesto",
        carousel_button: replyId,
        advancing_to: destino,
      });
      const outcome = await advanceFromNodeKey(db, run, destino, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Buffer de mensajes de «Esperar respuesta»: agrupa los mensajes que la
  // clienta manda dentro de la ventana en una sola variable antes de
  // avanzar. La ventana no se desliza: cuenta desde el primer mensaje.
  if (currentNode.node_type === "save_reply") {
    const cfgBuffer = currentNode.config as unknown as SaveReplyNodeConfig;
    const ventana = segundosBuffer(cfgBuffer);
    const enCurso = leerBuffer(run.vars, currentNode.node_key);
    if (enCurso || ventana > 0) {
      if (message.kind !== "text" || !message.text.trim()) {
        // Con el buffer abierto, lo que no sea texto se ignora.
        return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
      }
      const texto = message.text.trim();
      if (enCurso) {
        const vars = {
          ...run.vars,
          [VAR_BUFFER]: { ...enCurso, textos: [...enCurso.textos, texto] },
        };
        await db
          .from("flow_runs")
          .update({ vars })
          .eq("id", run.id)
          .eq("status", "active")
          .eq("transition_seq", run.transition_seq);
        run.vars = vars;
        return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
      }
      // Primer mensaje: abre el buffer y programa su cierre.
      const vars: Record<string, unknown> = {
        ...run.vars,
        [VAR_BUFFER]: {
          nodo: currentNode.node_key,
          inicio: new Date().toISOString(),
          textos: [texto],
          reply_to: message.meta_message_id ?? null,
        } satisfies BufferRespuesta,
      };
      if (cfgBuffer.citar_respuesta && message.meta_message_id) {
        vars[VAR_REPLY_TO] = message.meta_message_id;
      }
      if (cfgBuffer.reaccionar) {
        await reaccionarAlMensaje(db, run, message.meta_message_id);
      }
      const ok = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        currentNode.node_key,
        {
          next_run_at: new Date(Date.now() + ventana * 1000).toISOString(),
          resume_reason: "reply_buffer",
          vars,
        },
      );
      if (!ok) return lostReplyRace(db, run, currentNode.node_key);
      run.vars = vars;
      programarResumeBuffer(db, run.id, ventana);
      return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    }
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list") &&
    (matched = matchTypedReply(currentNode, message.text))
  ) {
    // La clienta escribió su respuesta en vez de tocar el botón: se avanza igual (abajo).
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "save_reply"
  ) {
    const cfg = currentNode.config as unknown as SaveReplyNodeConfig;
    const capturado = message.text.trim();
    // Como en Leona: «si contesta» sin conectar = la respuesta se guarda,
    // el flujo termina aquí y el mensaje sigue al agente de IA.
    if (capturado.length > 0 && !cfg.contesto_next) {
      if (cfg.var_key) {
        const vars = { ...run.vars, [cfg.var_key]: capturado };
        await db.from("flow_runs").update({ vars }).eq("id", run.id);
        run.vars = vars;
      }
      if (cfg.campo_contacto) await guardarEnContacto(db, run, cfg.campo_contacto, capturado);
      if (cfg.reaccionar) await reaccionarAlMensaje(db, run, message.meta_message_id);
      await logEvent(db, run.id, "completed", currentNode.node_key, { reason: "contesto_sin_salida" });
      await endRun(db, run.id, "completed", "contesto_sin_salida");
      return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
    }
    if (capturado.length > 0 && cfg.var_key && cfg.contesto_next) {
      const vars = { ...run.vars, [cfg.var_key]: capturado };
      if (cfg.citar_respuesta && message.meta_message_id) {
        vars[VAR_REPLY_TO] = message.meta_message_id;
      }
      if (!(await claimReplyTransition(db, run, cfg.contesto_next, { vars }))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      run.vars = vars;
      if (cfg.reaccionar) {
        await reaccionarAlMensaje(db, run, message.meta_message_id);
      }
      if (cfg.campo_contacto) {
        await guardarEnContacto(db, run, cfg.campo_contacto, capturado);
      }
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        saved_key: cfg.var_key,
        saved_length: capturado.length,
        via: "contesto",
      });
      const outcome = await advanceFromNodeKey(db, run, cfg.contesto_next, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key && cfg.next_node_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      run.vars = newVars;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.var_key,
        captured_length: captured.length,
      });
      const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
  }

  if (matched) {
    if (!(await claimReplyTransition(db, run, matched))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(flow.fallback_policy);
  const newReprompts = run.reprompt_count + 1;
  const action = decideFallback({ policy, reprompt_count: newReprompts });
  if (action.type === "ignore") {
    await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
      action: action.type,
      reprompt_count: newReprompts,
    });
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }

  const fallbackClaim: Record<string, unknown> =
    action.type === "reprompt"
      ? { reprompt_count: newReprompts }
      : {
          reprompt_count: newReprompts,
          status: action.type === "handoff" ? "handed_off" : "completed",
          ended_at: new Date().toISOString(),
          end_reason:
            action.type === "handoff"
              ? "fallback_exhausted"
              : "fallback_exhausted_end",
        };
  if (!(await claimFallbackTransition(db, run, fallbackClaim))) {
    return lostReplyRace(db, run, currentNode.node_key);
  }
  await logEvent(db, run.id, "fallback_fired", currentNode.node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "collect_input") {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await ritmoHumano(db, run, cfg.prompt_text ?? "");
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function claimFallbackTransition(
  db: AdminClient,
  run: FlowRunRow,
  update: Record<string, unknown>,
): Promise<boolean> {
  const fromKey = run.current_node_key;
  if (fromKey === null) return false;
  const nextSeq = (run.transition_seq ?? 0) + 1;
  const { data, error } = await db
    .from("flow_runs")
    .update({ ...update, transition_seq: nextSeq })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (error) {
    console.error("[flows] claimFallbackTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.transition_seq = nextSeq;
  run.reprompt_count = update.reprompt_count as number;
  return true;
}

async function lostReplyRace(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", nodeKey, {
    reason: "lost_race_during_reply",
  });
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: "duplicate_inbound_ignored",
  };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

/** Transfiere la corrida a otro flujo activo (máx. 5 saltos). */
async function transferirAFlujo(
  db: AdminClient,
  run: FlowRunRow,
  targetFlowId: string | undefined,
): Promise<"completed" | "advanced" | "handed_off"> {
  const cerrar = async (motivo: string) => {
    await logEvent(db, run.id, "error", run.current_node_key, {
      reason: motivo,
    });
    await endRun(db, run.id, "completed", motivo);
    return "completed" as const;
  };
  if (!targetFlowId) return cerrar("connect_flow_sin_destino");
  const target = await loadFlow(db, targetFlowId);
  if (
    !target ||
    target.account_id !== run.account_id ||
    target.status !== "active" ||
    !target.entry_node_id
  ) {
    return cerrar("connect_flow_destino_invalido");
  }
  const cadena = Array.isArray(run.vars.__flow_chain)
    ? run.vars.__flow_chain
    : [];
  if (!puedeTransferir(cadena, targetFlowId)) {
    return cerrar("connect_flow_bucle");
  }
  const vars = {
    ...run.vars,
    __flow_chain: [...(cadena as unknown[]), targetFlowId],
  };
  const ahora = new Date().toISOString();
  await endRun(db, run.id, "completed", "transferred");
  const { data: nuevo, error } = await db
    .from("flow_runs")
    .insert({
      account_id: run.account_id,
      user_id: run.user_id,
      contact_id: run.contact_id,
      conversation_id: run.conversation_id,
      flow_id: targetFlowId,
      current_node_key: target.entry_node_id,
      status: "active",
      vars,
      transition_seq: 0,
      started_at: ahora,
      last_advanced_at: ahora,
    })
    .select("*")
    .single();
  if (error || !nuevo) {
    await logEvent(db, run.id, "error", run.current_node_key, {
      reason: "connect_flow_insert_failed",
      detail: error?.message,
    });
    return "completed";
  }
  const nodos = await loadAllNodes(db, targetFlowId);
  const res = await advanceFromNodeKey(
    db,
    nuevo as FlowRunRow,
    target.entry_node_id,
    nodos,
  );
  return res.outcome;
}

/** Bloque de IA: contexto + medios + DeepSeek + JSON + ruteo. */
async function ejecutarAiBlock(
  db: AdminClient,
  run: FlowRunRow,
  cfg: AiBlockNodeConfig,
): Promise<string> {
  const config = await configIaDeBloque(db, run.account_id, run.flow_id, cfg);
  if (!config) return cfg.fallback_next;

  const ventana = Math.min(Math.max(cfg.context_window ?? 10, 5), 20);
  const { data: filas } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", run.conversation_id!)
    .order("created_at", { ascending: false })
    .limit(ventana);
  const mensajes = ((filas ?? []) as Array<Record<string, unknown>>).reverse();
  const ultimoCliente = [...mensajes]
    .reverse()
    .find((m) => m.sender_type === "customer");

  let extra = "";
  let comprobanteValido = false;
  const creds = await credencialesDeConversacion(
    db,
    run.conversation_id,
    run.account_id,
  );
  if (cfg.identify_receipt && ultimoCliente?.media_id && creds) {
    try {
      const lectura = await leerComprobanteDeMedio({
        accountId: run.account_id,
        mediaId: String(ultimoCliente.media_id),
        mime: String(ultimoCliente.content_type ?? "image/jpeg"),
        accessToken: creds.accessToken,
      });
      if (lectura?.es_comprobante) {
        comprobanteValido = true;
        extra += `\nComprobante leído: ${JSON.stringify(lectura)}`;
      }
    } catch {
      /* no frena */
    }
  }
  if (cfg.understand_pdf && ultimoCliente?.media_url) {
    try {
      const res = await fetch(String(ultimoCliente.media_url));
      const { extractText } = await import("unpdf");
      const { text } = await extractText(
        new Uint8Array(await res.arrayBuffer()),
      );
      extra += `\nPDF: ${String(text).slice(0, 4000)}`;
    } catch {
      /* no frena */
    }
  }
  if (cfg.understand_image && ultimoCliente?.media_url) {
    try {
      const { leerImagen } = await import("@/lib/ai/comprension/vision");
      const img = await leerImagen({
        db,
        accountId: run.account_id,
        conversationId: run.conversation_id,
        config,
        mediaUrl: String(ultimoCliente.media_url),
        caption: String(ultimoCliente.content_text ?? ""),
      });
      if (img?.resumen) extra += `\nImagen: ${img.resumen}`;
    } catch {
      /* no frena */
    }
  }
  if (cfg.understand_audio && ultimoCliente?.media_url) {
    try {
      const { transcribirNota } = await import("@/lib/ai/comprension/asr");
      const asr = await transcribirNota({
        config,
        mediaUrl: String(ultimoCliente.media_url),
        accessToken: creds?.accessToken,
        mimeType: String(ultimoCliente.content_type ?? "audio/ogg"),
      });
      if (asr?.texto) extra += `\nAudio: ${asr.texto}`;
    } catch {
      /* no frena */
    }
  }

  const plantilla = cfg.message_template || "{{last_user_message}}";
  const textoCliente = String(ultimoCliente?.content_text ?? "");
  const mensaje = `${interpolateVars(plantilla, {
    ...run.vars,
    last_user_message: textoCliente,
  })}${extra}`;

  const systemPrompt = promptSistemaBloqueIa(cfg);
  const contexto = mensajes.map((m) => ({
    role:
      m.sender_type === "customer"
        ? ("user" as const)
        : ("assistant" as const),
    content: String(m.content_text ?? ""),
  }));
  if (textoCliente) contexto.pop();
  contexto.push({ role: "user" as const, content: mensaje });

  let respuesta = "";
  let salida: string | null = null;
  try {
    const gen = await generateReply({ config, systemPrompt, messages: contexto });
    const parsed = parsearSalidaIa(gen.text);
    respuesta = parsed.respuesta;
    salida = parsed.salida;
  } catch (err) {
    await logEvent(db, run.id, "error", run.current_node_key, {
      reason: "ai_block_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return cfg.fallback_next;
  }

  const varSalida = cfg.output_var?.trim() || "ai.response";
  run.vars[varSalida] = respuesta;
  await db
    .from("flow_runs")
    .update({ vars: run.vars })
    .eq("id", run.id)
    .eq("transition_seq", run.transition_seq ?? 0);

  if (cfg.auto_send && respuesta.trim()) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: respuesta,
      });
    } catch {
      /* no frena */
    }
  }

  return destinoBloqueIa(cfg, salida, comprobanteValido);
}

/**
 * Configuración de IA de un bloque: la del flujo o la de la cuenta, con
 * el modelo del nodo si lo trae. La usa también el simulador del editor.
 */
export async function configIaDeBloque(
  db: AdminClient,
  accountId: string,
  flowId: string,
  cfg: AiBlockNodeConfig,
) {
  const config =
    cfg.credential_source === "flow"
      ? await cargarAiConfigDeFlujo(db, { flow_id: flowId }, cfg)
      : await loadAiConfig(db, accountId);
  if (!config) return null;
  return cfg.model ? { ...config, model: cfg.model } : config;
}

async function cargarAiConfigDeFlujo(
  db: AdminClient,
  run: Pick<FlowRunRow, "flow_id">,
  cfg: AiBlockNodeConfig,
) {
  const { data } = await db
    .from("flow_ai_configs")
    .select("provider, model, base_url, api_key")
    .eq("flow_id", run.flow_id)
    .maybeSingle();
  if (!data?.api_key) return null;
  return {
    provider: data.provider as "openai" | "anthropic" | "openai_compatible",
    model: (cfg.model || data.model) as string,
    baseUrl: (data.base_url as string | null) ?? null,
    apiKey: decrypt(data.api_key as string),
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    visionModel: null,
    asrModel: null,
    orquestador: true,
    catalogStrict: false,
  };
}

async function ejecutarManipulador(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as ManipulatorNodeConfig;
  const raw = interpolateVars(cfg.value ?? "", run.vars);
  if (cfg.target === "var") {
    const actual = run.vars[cfg.key];
    const n = Number(actual) || 0;
    let next: unknown;
    if (cfg.operation === "clear") next = "";
    else if (cfg.operation === "add") next = n + (Number(raw) || 0);
    else if (cfg.operation === "subtract") next = n - (Number(raw) || 0);
    else next = cfg.value_type === "number" ? Number(raw) || 0 : raw;
    run.vars[cfg.key] = next;
    await db.from("flow_runs").update({ vars: run.vars }).eq("id", run.id)
      .eq("transition_seq", run.transition_seq ?? 0);
    return;
  }
  if (cfg.key.startsWith("custom:")) {
    const fieldId = cfg.key.slice(7);
    const { data: field } = await db.from("custom_fields").select("id")
      .eq("id", fieldId).eq("account_id", run.account_id).maybeSingle();
    if (!field) return;
    let valor = raw;
    if (cfg.operation === "clear") valor = "";
    else if (cfg.operation === "add" || cfg.operation === "subtract") {
      const { data: cur } = await db.from("contact_custom_values").select("value")
        .eq("contact_id", run.contact_id!).eq("custom_field_id", fieldId).maybeSingle();
      const n = Number(cur?.value) || 0;
      valor = String(cfg.operation === "add" ? n + (Number(raw) || 0) : n - (Number(raw) || 0));
    }
    await db.from("contact_custom_values").upsert(
      { contact_id: run.contact_id!, custom_field_id: fieldId, value: valor },
      { onConflict: "contact_id,custom_field_id" },
    );
    return;
  }
  if (!["name", "email", "company"].includes(cfg.key)) return;
  await db.from("contacts").update({ [cfg.key]: raw || null })
    .eq("id", run.contact_id!).eq("account_id", run.account_id);
}

async function elegirDistribuidor(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<string> {
  const cfg = node.config as unknown as DistributorNodeConfig;
  const outputs = cfg.outputs ?? [];
  if (outputs.length === 0) return "";
  const { data, error } = await db.rpc("elegir_salida_distribuidor", {
    p_account_id: run.account_id,
    p_flow_id: run.flow_id,
    p_node_key: node.node_key,
    p_contact_id: run.contact_id,
    p_outputs: outputs.length,
    p_avoid_repeat: cfg.mode === "avoid_repeat",
  });
  if (error) return outputs[0]?.next_node_key ?? "";
  return outputs[Number(data) || 0]?.next_node_key ?? outputs[0]?.next_node_key ?? "";
}

async function enviarNotificacion(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as NotificationNodeConfig;
  const creds = await credencialesPrimarias(db, run.account_id);
  if (!creds) throw new Error("WhatsApp no configurado");
  const cc = (cfg.country_code ?? "52").replace(/\D/g, "");
  const phone = `${cc}${String(cfg.phone ?? "").replace(/\D/g, "")}`;
  await sendTextMessage({
    phoneNumberId: creds.phoneNumberId,
    accessToken: creds.accessToken,
    to: phone,
    text: interpolateVars(cfg.message, run.vars),
  });
}

interface VentaConfig {
  amount_var?: string;
  currency_var?: string;
  name_var?: string;
  pipeline_id?: string;
  stage_id?: string;
  send_capi?: boolean;
  notify?: boolean;
}

async function registrarVenta(
  db: AdminClient,
  run: FlowRunRow,
  cfg: VentaConfig,
  override?: {
    amount: number;
    currency: string;
    eventId?: string;
    sessionId?: string;
  },
): Promise<string | null> {
  const amount = override?.amount ?? (Number(run.vars[cfg.amount_var ?? ""]) || 0);
  const { data: cuenta } = await db.from("accounts").select("default_currency")
    .eq("id", run.account_id).maybeSingle();
  const currency = override?.currency
    ? override.currency
    : cfg.currency_var
      ? String(run.vars[cfg.currency_var] ?? cuenta?.default_currency ?? "MXN")
      : (cuenta?.default_currency ?? "MXN");
  const { data: contacto } = await db.from("contacts").select("name")
    .eq("id", run.contact_id!).maybeSingle();
  const title = (cfg.name_var ? String(run.vars[cfg.name_var] ?? "") : "") || contacto?.name || "Venta";
  const now = new Date().toISOString();
  let saleId: string | null = null;
  const { data: convVenta } = run.conversation_id
    ? await db.from("conversations").select("connection_id")
        .eq("id", run.conversation_id).maybeSingle()
    : { data: null };
  const connectionId =
    (convVenta as { connection_id?: string | null } | null)?.connection_id ?? null;

  if (cfg.pipeline_id && cfg.stage_id) {
    const { data: deal } = await db.from("deals").select("id")
      .eq("account_id", run.account_id).eq("contact_id", run.contact_id!)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (deal?.id) {
      await db.from("deals").update({
        pipeline_id: cfg.pipeline_id, stage_id: cfg.stage_id, status: "won",
        value: amount, currency, title, closed_at: now,
      }).eq("id", deal.id);
      const { data: venta } = await db.from("sales").select("id")
        .eq("account_id", run.account_id).eq("source_ref", `deal:${deal.id}`).maybeSingle();
      saleId = (venta as { id?: string } | null)?.id ?? null;
    } else {
      const { data: nuevo } = await db.from("deals").insert({
        account_id: run.account_id, user_id: run.user_id,
        pipeline_id: cfg.pipeline_id, stage_id: cfg.stage_id,
        contact_id: run.contact_id, conversation_id: run.conversation_id,
        title, value: amount, currency, status: "won", closed_at: now,
      }).select("id").maybeSingle();
      const dealId = (nuevo as { id?: string } | null)?.id;
      if (dealId) {
        const { data: venta } = await db.from("sales").select("id")
          .eq("account_id", run.account_id).eq("source_ref", `deal:${dealId}`).maybeSingle();
        saleId = (venta as { id?: string } | null)?.id ?? null;
      }
    }
  } else if (override?.sessionId) {
    // Sin embudo configurado: la venta queda igual en el dashboard.
    const sourceRef = `gateway:${override.sessionId}`;
    const { data: existente } = await db.from("sales").select("id")
      .eq("account_id", run.account_id).eq("source_ref", sourceRef).maybeSingle();
    if (existente) {
      saleId = (existente as { id: string }).id;
    } else {
      const { data: nueva } = await db.from("sales").insert({
        account_id: run.account_id, contact_id: run.contact_id,
        conversation_id: run.conversation_id, connection_id: connectionId, amount, currency,
        status: "confirmed", source: "payment_gateway",
        source_ref: sourceRef, sold_at: now,
        client_name: title,
      }).select("id").maybeSingle();
      saleId = (nueva as { id?: string } | null)?.id ?? null;
    }
  }

  // Sin CAPI, LowTrack igual recibe la venta (con CAPI la manda
  // enviarEventoMeta con el mismo event_id).
  if (!cfg.send_capi && amount > 0) {
    await enviarVentaLowtrack({
      accountId: run.account_id, contactId: run.contact_id,
      transactionId: override?.eventId ?? `sale-${run.id}-${run.current_node_key}`,
      amount, currency, producto: title,
    });
  }
  if (cfg.send_capi && amount > 0) {
    try {
      await enviarEventoMeta({
        accountId: run.account_id, contactId: run.contact_id!,
        conversationId: run.conversation_id,
        eventName: "Purchase",
        eventId: override?.eventId ?? `sale-${run.id}-${run.current_node_key}`,
        value: amount, currency,
      });
    } catch (err) {
      console.error(
        "[flows] no se pudo enviar Purchase a Meta CAPI:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (cfg.notify) {
    try {
      await db.from("notifications").insert({
        account_id: run.account_id, user_id: run.user_id, type: "sale_approved",
        contact_id: run.contact_id, conversation_id: run.conversation_id,
        title: "Venta aprobada", body: `${title} · ${amount} ${currency}`,
      });
    } catch (err) {
      console.error(
        "[flows] no se pudo crear la notificación de venta:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return saleId;
}

async function registrarVentaAprobada(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as SaleApprovedNodeConfig;
  await registrarVenta(db, run, cfg);
}

async function ventanaServicioAbierta(
  db: AdminClient,
  conversationId: string | null,
): Promise<boolean> {
  if (!conversationId) return true;
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultima = (data as { created_at?: string } | null)?.created_at;
  if (!ultima) return true;
  return Date.now() - new Date(ultima).getTime() <= VENTANA_SERVICIO_MS;
}

async function renderFichas(
  db: AdminClient,
  run: FlowRunRow,
  textos: string[],
): Promise<string[]> {
  const datos = await cargarDatosFichas(db, {
    accountId: run.account_id,
    contactId: run.contact_id!,
    vars: run.vars,
    textos,
  });
  return textos.map((t) => sustituirFichas(t, datos));
}

async function montoDePasarela(
  db: AdminClient,
  run: FlowRunRow,
  cfg: PaymentGatewayNodeConfig,
): Promise<{ amount: number; currency: string } | null> {
  const amount =
    cfg.amount_mode === "variable"
      ? Number(run.vars[cfg.amount_var ?? ""]) || 0
      : Number(cfg.amount) || 0;
  if (!(amount > 0)) return null;
  const { data: cuenta } = await db.from("accounts").select("default_currency")
    .eq("id", run.account_id).maybeSingle();
  const currency = cfg.currency || (cuenta as { default_currency?: string } | null)?.default_currency || "MXN";
  return { amount, currency };
}

async function crearSesionPago(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: PaymentGatewayNodeConfig,
  amount: number,
  currency: string,
  reference: string,
  checkoutUrl: string | null,
  expiresAt: string,
): Promise<string> {
  const { data, error } = await db
    .from("flow_payment_sessions")
    .insert({
      account_id: run.account_id,
      flow_id: run.flow_id,
      flow_run_id: run.id,
      node_key: node.node_key,
      contact_id: run.contact_id,
      conversation_id: run.conversation_id,
      provider: cfg.provider,
      reference,
      amount,
      currency,
      status: "pending",
      checkout_url: checkoutUrl,
      expires_at: expiresAt,
      metadata: { concept: cfg.concept ?? null },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`No se pudo crear la sesión de pago: ${error?.message ?? "sin fila"}`);
  }
  return (data as { id: string }).id;
}

async function enviarMensajePasarela(
  db: AdminClient,
  run: FlowRunRow,
  cfg: PaymentGatewayNodeConfig,
  args: { amount: number; currency: string; reference: string; checkoutUrl: string },
): Promise<void> {
  const abierta = await ventanaServicioAbierta(db, run.conversation_id);

  if (cfg.provider === "spei") {
    const datos = await datosPagoDelNodo(db, run.account_id, {
      clabe: "",
      beneficiario: "",
      banco: "",
      monto: args.amount,
      referencia: args.reference,
      mensaje: cfg.concept,
      con_boton: false,
      espera_minutos: cfg.wait_minutes,
      aprobado_next: "",
      rechazado_next: "",
    });
    const texto = textoPagoSpei(datos, cfg.message);
    if (abierta) {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: texto,
      });
      return;
    }
    if (cfg.template_name) {
      await engineSendTemplate({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        templateName: cfg.template_name,
        language: cfg.template_language || "es_MX",
        params: [datos.clabe, String(datos.monto), args.reference],
        reason: "flow_payment_spei",
      });
      return;
    }
    throw new Error("La ventana de 24 h está cerrada y no hay plantilla SPEI.");
  }

  const [mensaje, url] = await renderFichas(db, run, [
    cfg.message?.trim() || "Aquí tienes tu enlace de pago seguro 👇",
    args.checkoutUrl,
  ]);
  const texto = `${mensaje}\n\n${url}`;
  if (abierta) {
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: texto,
    });
    return;
  }
  if (cfg.template_name) {
    const variables = { ...(cfg.template_variables ?? {}) };
    if (!variables["1"]) variables["1"] = url;
    await engineSendTemplate({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      templateName: cfg.template_name,
      language: cfg.template_language || "es_MX",
      params: Object.keys(variables)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => variables[k]),
      reason: "flow_payment_link",
    });
    return;
  }
  throw new Error("La ventana de 24 h está cerrada y no hay plantilla de pago.");
}

async function ejecutarPasarelaPago(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<"advanced" | "completed"> {
  const cfg = node.config as unknown as PaymentGatewayNodeConfig;
  const monto = await montoDePasarela(db, run, cfg);
  if (!monto) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "payment_amount_invalid",
    });
    await endRun(db, run.id, "failed", "payment_amount_invalid");
    return "completed";
  }

  const reference = generarReferencia(cfg.provider);
  const [checkoutUrlRaw] = await renderFichas(db, run, [cfg.checkout_url ?? ""]);
  const checkoutUrl = checkoutUrlRaw
    .replace(/\{\{\s*payment_ref\s*\}\}/g, reference)
    .replace(/\{\{\s*amount\s*\}\}/g, String(monto.amount))
    .replace(/\{\{\s*currency\s*\}\}/g, monto.currency)
    .replace(/\{\{\s*reference\s*\}\}/g, reference);

  if (cfg.provider !== "spei" && !checkoutUrl.trim()) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "payment_checkout_missing",
    });
    await endRun(db, run.id, "failed", "payment_checkout_missing");
    return "completed";
  }

  const waitMin = Math.min(
    Math.max(Number(cfg.wait_minutes) || 120, 5),
    PAYMENT_GATEWAY_MAX_MINUTOS,
  );
  const expiresAt = new Date(Date.now() + waitMin * 60_000).toISOString();
  let sessionId: string;
  try {
    sessionId = await crearSesionPago(
      db, run, node, cfg, monto.amount, monto.currency,
      reference, checkoutUrl || null, expiresAt,
    );
    await enviarMensajePasarela(db, run, cfg, {
      amount: monto.amount,
      currency: monto.currency,
      reference,
      checkoutUrl,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "payment_send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    await endRun(db, run.id, "failed", "payment_send_failed");
    return "completed";
  }

  const vars: Record<string, unknown> = {
    ...run.vars,
    [VAR_PAYMENT_REF]: reference,
    [VAR_PAYMENT_SESSION]: sessionId,
    [VAR_PAYMENT_STATUS]: "pending",
  };
  const ok = await advanceCurrentNodeKey(
    db,
    run.id,
    run.current_node_key,
    node.node_key,
    {
      next_run_at: expiresAt,
      resume_reason: "payment_gateway",
      vars,
    },
  );
  if (!ok) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "lost_race_during_advance",
    });
    return "completed";
  }
  run.vars = vars;
  await logEvent(db, run.id, "node_entered", node.node_key, {
    node_type: "payment_gateway",
    provider: cfg.provider,
    amount: monto.amount,
    currency: monto.currency,
    reference,
  });
  return "advanced";
}

/**
 * Registra la venta de una sesión aprobada aunque la corrida ya se haya
 * movido (pago tardío tras el timeout). Idempotente por `sale_id`.
 */
export async function registrarVentaDeSesionAprobada(
  db: AdminClient,
  sessionId: string,
): Promise<string | null> {
  const { data: session } = await db
    .from("flow_payment_sessions")
    .select("id, flow_run_id, node_key, amount, currency, sale_id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return null;
  const fila = session as {
    id: string;
    flow_run_id: string;
    node_key: string;
    amount: number;
    currency: string;
    sale_id: string | null;
    status: string;
  };
  if (fila.sale_id) return fila.sale_id;
  if (fila.status !== "approved") return null;

  const { data: runRow } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", fila.flow_run_id)
    .maybeSingle();
  const run = runRow as FlowRunRow | null;
  if (!run) return null;
  const nodes = await loadAllNodes(db, run.flow_id);
  const node = nodes.get(fila.node_key);
  if (!node || node.node_type !== "payment_gateway") return null;
  const cfg = node.config as unknown as PaymentGatewayNodeConfig;
  const saleId = await registrarVenta(db, run, cfg, {
    amount: Number(fila.amount) || 0,
    currency: String(fila.currency || cfg.currency || "MXN"),
    eventId: `gateway:${sessionId}`,
    sessionId,
  });
  await db
    .from("flow_payment_sessions")
    .update({ sale_id: saleId, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
  return saleId;
}

/**
 * Despierta una corrida estacionada en `payment_gateway`. Lo usan el
 * webhook de la pasarela y la confirmación manual. Idempotente: el
 * `transition_seq` decide quién gana.
 */
export async function resumePaymentGateway(
  db: AdminClient,
  args: {
    runId: string;
    decision: "approved" | "rejected" | "expired";
    sessionId?: string | null;
  },
): Promise<boolean> {
  const { data: fila } = await db.from("flow_runs").select("*").eq("id", args.runId).maybeSingle();
  const run = fila as FlowRunRow | null;
  if (!run || run.status !== "active" || run.resume_reason !== "payment_gateway") return false;
  if (!run.current_node_key) return false;
  const nodes = await loadAllNodes(db, run.flow_id);
  const node = nodes.get(run.current_node_key);
  if (!node || node.node_type !== "payment_gateway") return false;
  const cfg = node.config as unknown as PaymentGatewayNodeConfig;
  const next =
    args.decision === "approved"
      ? cfg.approved_next
      : args.decision === "rejected"
        ? cfg.rejected_next || cfg.timeout_next
        : cfg.timeout_next || cfg.rejected_next;
  if (!next) {
    await endRun(db, run.id, "completed", `payment_gateway_${args.decision}`);
    return true;
  }
  if (!(await claimReplyTransition(db, run, next))) return false;

  if (args.decision === "approved") {
    let amount = Number(run.vars[`__payment_amount`]) || 0;
    let currency = String(run.vars[`__payment_currency`] ?? cfg.currency ?? "MXN");
    try {
      if (args.sessionId) {
        const { data: session } = await db.from("flow_payment_sessions").select("*")
          .eq("id", args.sessionId).maybeSingle();
        if (session) {
          amount = Number((session as { amount?: number }).amount) || amount;
          currency = String((session as { currency?: string }).currency ?? currency);
          const yaVendida = (session as { sale_id?: string | null }).sale_id;
          if (!yaVendida) {
            const saleId = await registrarVenta(db, run, cfg, {
              amount,
              currency,
              eventId: `gateway:${args.sessionId}`,
              sessionId: args.sessionId,
            });
            await db.from("flow_payment_sessions").update({
              sale_id: saleId,
              status: "approved",
              approved_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq("id", args.sessionId);
          }
        }
      } else {
        await registrarVenta(db, run, cfg, { amount, currency, eventId: `gateway:${run.id}` });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "payment_sale_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const etiqueta = (cfg.etiqueta_al_aprobar ?? "").trim();
    if (etiqueta) {
      await etiquetar(run.account_id, run.user_id, run.contact_id!, etiqueta).catch(
        (err) => console.error("[flows] no se pudo etiquetar el pago:", err),
      );
    }
  }

  await logEvent(db, run.id, "node_entered", node.node_key, {
    node_type: "payment_gateway",
    via: args.decision,
    advancing_to: next,
  });
  await advanceFromNodeKey(db, run, next, nodes);
  return true;
}

async function resumePaymentGatewayTimeout(
  db: AdminClient,
  run: FlowRunRow,
): Promise<boolean> {
  // El webhook y la confirmación manual ponen `next_run_at = ahora` como
  // respaldo, así que el cron puede llegar aquí con la sesión YA cerrada.
  // La decisión sale de la sesión: si ya está aprobada o rechazada no se
  // manda la corrida por el timeout (un cliente que pagó no debe recibir
  // el mensaje de «no llegó tu pago»).
  const { data: session } = await db.from("flow_payment_sessions").select("id, status")
    .eq("flow_run_id", run.id).eq("node_key", run.current_node_key ?? "")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const fila = session as { id: string; status: string } | null;
  const decisionDe = (status: string | undefined): "approved" | "rejected" | "expired" =>
    status === "approved" ? "approved" : status === "rejected" ? "rejected" : "expired";
  let decision = decisionDe(fila?.status);
  if (fila?.status === "pending") {
    // Atómico: si un webhook la cerró entre la lectura y el update, no se
    // pisa su estado (antes quedaba `expired` y la venta tardía se perdía).
    const { data: expiradas } = await db.from("flow_payment_sessions").update({
      status: "expired",
      updated_at: new Date().toISOString(),
    }).eq("id", fila.id).eq("status", "pending").select("id");
    if (!expiradas || (expiradas as unknown[]).length === 0) {
      const { data: releida } = await db.from("flow_payment_sessions").select("status")
        .eq("id", fila.id).maybeSingle();
      decision = decisionDe((releida as { status?: string } | null)?.status);
    }
  }
  return resumePaymentGateway(db, {
    runId: run.id,
    decision,
    sessionId: fila?.id ?? null,
  });
}

async function upsertCallSession(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  args: {
    phoneNumberId: string;
    connectionId?: string | null;
    requestWamid: string | null;
    permissionStatus: string;
    expiresAt: string;
  },
): Promise<string> {
  const { data, error } = await db
    .from("flow_call_sessions")
    .upsert(
      {
        account_id: run.account_id,
        flow_id: run.flow_id,
        flow_run_id: run.id,
        node_key: node.node_key,
        contact_id: run.contact_id,
        conversation_id: run.conversation_id,
        connection_id: args.connectionId ?? null,
        phone_number_id: args.phoneNumberId,
        request_wamid: args.requestWamid,
        permission_status:
          args.permissionStatus === "temporary" || args.permissionStatus === "permanent"
            ? args.permissionStatus
            : args.permissionStatus === "no_permission"
              ? "no_permission"
              : "unknown",
        status: "requested",
        expires_at: args.expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "flow_run_id,node_key" },
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`No se pudo guardar la sesión de llamada: ${error?.message ?? "sin fila"}`);
  }
  return (data as { id: string }).id;
}

async function ejecutarLlamadaOficial(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<"advanced" | "completed"> {
  const cfg = node.config as unknown as OfficialCallNodeConfig;
  const creds = await credencialesDeConversacion(db, run.conversation_id, run.account_id);
  if (!creds) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "call_sin_whatsapp" });
    await endRun(db, run.id, "failed", "call_sin_whatsapp");
    return "completed";
  }
  if (!creds.connectionId) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "call_sin_conexion",
    });
    return irA(cfg.denied_next, db, run);
  }

  const { data: contacto } = await db.from("contacts")
    .select("phone, wa_user_id")
    .eq("id", run.contact_id!)
    .eq("account_id", run.account_id)
    .maybeSingle();
  const waId = String(
    (contacto as { wa_user_id?: string; phone?: string } | null)?.wa_user_id ||
      (contacto as { phone?: string } | null)?.phone ||
      "",
  ).replace(/\D/g, "");
  if (!waId) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "call_sin_destino" });
    return irA(cfg.denied_next, db, run);
  }

  let phoneNumber = "";
  let messagingLimit: string | null = null;
  if (creds.connectionId) {
    const { data: conn } = await db.from("whatsapp_connections")
      .select(
        "phone_number, display_phone_number, messaging_limit_tier, whatsapp_business_manager_messaging_limit",
      )
      .eq("id", creds.connectionId)
      .maybeSingle();
    phoneNumber = String(
      (conn as { display_phone_number?: string | null; phone_number?: string | null } | null)
        ?.display_phone_number ??
        (conn as { phone_number?: string | null } | null)?.phone_number ??
        "",
    );
    const filaConn = conn as {
      messaging_limit_tier?: string | null;
      whatsapp_business_manager_messaging_limit?: string | null;
    } | null;
    messagingLimit =
      filaConn?.whatsapp_business_manager_messaging_limit ??
      filaConn?.messaging_limit_tier ??
      null;
  }
  const porPais = disponibilidadPorPais(phoneNumber, messagingLimit);
  if (!porPais.supported) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "call_no_disponible",
      detail: porPais.detail,
      country: porPais.country,
    });
    return irA(cfg.denied_next, db, run);
  }

  let settings: Awaited<ReturnType<typeof refrescarEstadoLlamadas>>;
  try {
    settings = await refrescarEstadoLlamadas(db, {
      accountId: run.account_id,
      connectionId: creds.connectionId ?? "",
      creds,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "call_settings_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return irA(cfg.denied_next, db, run);
  }
  const estado = estadoDesdeSettings(settings);
  if (!estado.supported) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "call_no_disponible",
      detail: estado.detail,
    });
    return irA(cfg.denied_next, db, run);
  }

  const ventana = await ventanaServicioAbierta(db, run.conversation_id);
  const [bodyText] = await renderFichas(db, run, [cfg.body_text]);
  let permiso: Awaited<ReturnType<typeof solicitarPermisoLlamada>>;
  try {
    permiso = await solicitarPermisoLlamada(db, {
      accountId: run.account_id,
      contactId: run.contact_id!,
      conversationId: run.conversation_id,
      creds,
      userWaId: waId,
      bodyText,
      templateName: cfg.template_name,
      templateLanguage: cfg.template_language,
      templateVariables: cfg.template_variables,
      ventanaAbierta: ventana,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "call_permission_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return irA(cfg.denied_next, db, run);
  }

  const dias = Math.min(Math.max(Number(cfg.wait_days) || CALL_PERMISSION_MAX_DIAS, 1), CALL_PERMISSION_MAX_DIAS);
  const expiresAt = new Date(Date.now() + dias * 86_400_000).toISOString();
  const sessionId = await upsertCallSession(db, run, node, {
    phoneNumberId: creds.phoneNumberId,
    connectionId: creds.connectionId,
    requestWamid: permiso.messageId,
    permissionStatus: permiso.permiso?.permission?.status ?? "unknown",
    expiresAt,
  });
  const vars = { ...run.vars, [VAR_CALL_SESSION]: sessionId };
  run.vars = vars;

  if (permiso.via === "ya_concedido") {
    if (cfg.mode === "call" && cfg.call_bridge === "sip") {
      const puente = await cargarPuenteSip(db, creds.connectionId);
      if (puente) {
        const r = await dispararPuenteSip({
          puente,
          phoneNumberId: creds.phoneNumberId,
          to: waId,
          reference: `call:${sessionId}`,
        }).catch((err) => ({ ok: false, status: 0, detalle: err instanceof Error ? err.message : String(err) }));
        await logEvent(db, run.id, r.ok ? "node_entered" : "error", node.node_key, {
          node_type: "official_call",
          action: "sip_bridge",
          status: r.status,
          detail: r.detalle,
        });
      } else {
        await logEvent(db, run.id, "error", node.node_key, {
          node_type: "official_call",
          reason: "call_sin_puente_sip",
        });
      }
    }
    return irA(cfg.granted_next, db, run);
  }

  const ok = await advanceCurrentNodeKey(
    db,
    run.id,
    run.current_node_key,
    node.node_key,
    {
      next_run_at: expiresAt,
      resume_reason: "call_permission",
      vars,
    },
  );
  if (!ok) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "lost_race_during_advance",
    });
    return "completed";
  }
  await logEvent(db, run.id, "node_entered", node.node_key, {
    node_type: "official_call",
    via: permiso.via,
    request_wamid: permiso.messageId,
  });
  return "advanced";
}

async function irA(
  destino: string | undefined,
  db: AdminClient,
  run: FlowRunRow,
): Promise<"advanced" | "completed"> {
  if (!destino) {
    await endRun(db, run.id, "completed", "official_call_no_permission");
    return "completed";
  }
  const nodes = await loadAllNodes(db, run.flow_id);
  if (!(await claimReplyTransition(db, run, destino))) return "completed";
  await advanceFromNodeKey(db, run, destino, nodes);
  return "advanced";
}

async function handleCallPermissionReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  message: Extract<ParsedInbound, { kind: "call_permission" }>,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const cfg = node.config as unknown as OfficialCallNodeConfig;
  const { data: session } = await db.from("flow_call_sessions").select("id")
    .eq("flow_run_id", run.id).eq("node_key", node.node_key).maybeSingle();
  if (session) {
    await db.from("flow_call_sessions").update({
      status: message.response === "accept" ? "granted" : "denied",
      permission_status:
        message.response === "accept"
          ? message.is_permanent
            ? "permanent"
            : "temporary"
          : "no_permission",
      is_permanent: message.is_permanent,
      expires_at: message.expiration_timestamp
        ? new Date(message.expiration_timestamp * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    }).eq("id", (session as { id: string }).id);
  }

  if (message.response === "accept" && cfg.mode === "call" && cfg.call_bridge === "sip") {
    const creds = await credencialesDeConversacion(db, run.conversation_id, run.account_id);
    const puente = await cargarPuenteSip(db, creds?.connectionId);
    if (puente && creds) {
      const { data: contacto } = await db.from("contacts")
        .select("phone, wa_user_id")
        .eq("id", run.contact_id!)
        .eq("account_id", run.account_id)
        .maybeSingle();
      const to = String(
        (contacto as { wa_user_id?: string; phone?: string } | null)?.wa_user_id ||
          (contacto as { phone?: string } | null)?.phone ||
          "",
      ).replace(/\D/g, "");
      if (to) {
        await dispararPuenteSip({
          puente,
          phoneNumberId: creds.phoneNumberId,
          to,
          reference: `call:${(session as { id?: string } | null)?.id ?? run.id}`,
        }).catch(() => undefined);
      }
    }
  }

  const destino = message.response === "accept" ? cfg.granted_next : cfg.denied_next;
  if (!destino) {
    await logEvent(db, run.id, "completed", node.node_key, {
      via: "call_permission",
      response: message.response,
    });
    await endRun(db, run.id, "completed", "official_call_permission");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  if (!(await claimReplyTransition(db, run, destino))) {
    return lostReplyRace(db, run, node.node_key);
  }
  await logEvent(db, run.id, "node_entered", node.node_key, {
    via: "call_permission",
    response: message.response,
    advancing_to: destino,
  });
  const outcome = await advanceFromNodeKey(db, run, destino, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

async function resumeCallPermissionTimeout(
  db: AdminClient,
  run: FlowRunRow,
): Promise<boolean> {
  if (!run.current_node_key) return false;
  const nodes = await loadAllNodes(db, run.flow_id);
  const node = nodes.get(run.current_node_key);
  if (!node || node.node_type !== "official_call") return false;
  const cfg = node.config as unknown as OfficialCallNodeConfig;
  const { data: session } = await db.from("flow_call_sessions").select("id")
    .eq("flow_run_id", run.id).eq("node_key", node.node_key).maybeSingle();
  if (session) {
    await db.from("flow_call_sessions").update({
      status: "expired",
      updated_at: new Date().toISOString(),
    }).eq("id", (session as { id: string }).id);
  }
  const destino = cfg.timeout_next || cfg.denied_next;
  if (!destino) {
    await logEvent(db, run.id, "timeout", node.node_key, { node_type: "official_call" });
    await endRun(db, run.id, "completed", "official_call_timeout");
    return true;
  }
  if (!(await claimReplyTransition(db, run, destino))) return false;
  await logEvent(db, run.id, "timeout", node.node_key, {
    node_type: "official_call",
    advancing_to: destino,
  });
  await advanceFromNodeKey(db, run, destino, nodes);
  return true;
}



async function ejecutarCarrusel(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<"advanced" | "completed"> {
  const cfg = node.config as unknown as CarouselNodeConfig;
  if (cfg.intro_text?.trim()) {
    await engineSendText({
      accountId: run.account_id, userId: run.user_id,
      conversationId: run.conversation_id!, contactId: run.contact_id!,
      text: interpolateVars(cfg.intro_text, run.vars),
    });
  }
  for (const card of cfg.cards ?? []) {
    const buttons = (card.buttons ?? []).slice(0, 3)
      .filter((b) => b.type !== "url" && b.label)
      .map((b) => ({ id: `car_${card.id}_${b.id}`, title: b.label.slice(0, 20) }));
    if (buttons.length === 0) continue;
    await engineSendInteractiveButtons({
      accountId: run.account_id, userId: run.user_id,
      conversationId: run.conversation_id!, contactId: run.contact_id!,
      bodyText: interpolateVars(card.text || "—", run.vars),
      headerImageUrl: card.image_url || undefined,
      buttons,
    });
  }
  const days = Math.min(Math.max(Number(cfg.expires_days) || 1, 1), 31);
  const ok = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key, {
    next_run_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    resume_reason: "carousel_timeout",
  });
  return ok ? "advanced" : "completed";
}

async function resumeCarouselTimeout(db: AdminClient, runId: string, now: Date): Promise<boolean> {
  const { data: fila } = await db.from("flow_runs").select("*").eq("id", runId).maybeSingle();
  const run = fila as FlowRunRow | null;
  if (!run || run.status !== "active" || run.resume_reason !== "carousel_timeout") return false;
  const nodes = await loadAllNodes(db, run.flow_id);
  const nodo = run.current_node_key ? nodes.get(run.current_node_key) : null;
  if (!nodo || nodo.node_type !== "carousel") return false;
  const cfg = nodo.config as unknown as CarouselNodeConfig;
  if (!cfg.timeout_next) {
    await logEvent(db, run.id, "completed", nodo.node_key, { reason: "carousel_timeout" });
    await endRun(db, run.id, "completed", "carousel_timeout");
    return true;
  }
  if (!(await claimReplyTransition(db, run, cfg.timeout_next))) return false;
  await logEvent(db, run.id, "node_entered", nodo.node_key, {
    via: "timeout", advancing_to: cfg.timeout_next, timeout_at: now.toISOString(),
  });
  await advanceFromNodeKey(db, run, cfg.timeout_next, nodes);
  return true;
}
