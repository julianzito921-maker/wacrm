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
import { etiquetar, leerComprobanteDeMedio } from "@/lib/ventas/comprobante";
import { engineSendTemplate } from "@/lib/automations/meta-send";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { loadAccountMetaCredentials } from "./meta-send";
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
  ESPERA_MAX_SEGUNDOS,
  MAX_NODES_PER_ADVANCE,
  NODOS_FIN_DE_RAMA,
  VAR_BUFFER,
  VAR_CURSOR_BURBUJA,
  VAR_REPLY_TO,
  VENTANA_SERVICIO_MS,
  WAIT_INLINE_MAX_SEGUNDOS,
  WAIT_MAX_SEGUNDOS,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------------
// Respuestas ESCRITAS a botones y listas (13-nov-2026): muchas clientas
// no tocan el botón y escriben («sí», «45», «87 kilos», «las dos», «no
// gracias»). Sin esto el embudo se quedaba parado.
// ------------------------------------------------------------

/** Minúsculas, sin acentos, sin emojis ni signos. */
export function normalizarRespuesta(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rango numérico de un título: «Menos de 60 kg», «De 60 a 74 kg», «40 a 49», «90 kg o más», «Más de 20 kg», «Hasta 5 kg». */
export function rangoDeTitulo(titulo: string): [number, number] | null {
  const n = normalizarRespuesta(titulo);
  let m: RegExpMatchArray | null;
  if ((m = n.match(/^menos de (\d+)/))) return [0, Number(m[1]) - 1];
  if ((m = n.match(/^hasta (\d+)/))) return [0, Number(m[1])];
  if ((m = n.match(/^(?:de )?(\d+) (?:a|al) (\d+)/))) return [Number(m[1]), Number(m[2])];
  if ((m = n.match(/^mas de (\d+)/))) return [Number(m[1]) + 1, Infinity];
  if ((m = n.match(/^(\d+)(?: kg| kilos| anos)? o mas/))) return [Number(m[1]), Infinity];
  return null;
}

/**
 * Número que escribió la clienta según lo que se pregunta: en el peso («kg») prefiere el que
 * va con kg/kilos y nunca toma uno con «años»; en la edad, al revés. 1,67 (estatura) no cuenta.
 */
export function numeroEscrito(texto: string, unidad: "kg" | "anos" | null = null): number | null {
  const n = normalizarRespuesta(texto.replace(/(\d)[.,](\d)/g, "$1x$2"));
  const nums = [...n.matchAll(/(?:^|\s)(\d{1,3}) ?(kg|kgs|kilos?|k|anos?)?(?=\s|$)/g)].map((m) => ({
    n: Number(m[1]),
    u: m[2] ? (m[2].startsWith("k") ? "kg" : "anos") : null,
  }));
  const otra = unidad === "kg" ? "anos" : unidad === "anos" ? "kg" : null;
  const conUnidad = unidad ? nums.find((x) => x.u === unidad) : nums.find((x) => x.u);
  if (conUnidad) return conUnidad.n;
  const suelto = nums.find((x) => x.u === null || (otra === null && x.u));
  return suelto ? suelto.n : null;
}

const AFIRMA = /^(si|sip|simon|ok|okey|okay|va|vale|dale|claro|listo|empecemos|empezamos|vamos|de acuerdo|perfecto|lo quiero|quiero|me interesa|confirmo|agregar|agregalo|agregala|ya)\b/;
const NIEGA = /^(no|nop|nel|ahorita no)\b/;

/**
 * Empareja un texto escrito con una opción de un nodo de botones o lista.
 * Devuelve el next_node_key o null (si no hay una opción clara, sigue el
 * fallback normal y contesta la IA).
 */
export function matchTypedReply(
  node: { node_type: string; config: Record<string, unknown> },
  texto: string,
): string | null {
  type Opcion = { title: string; next_node_key: string };
  let opciones: Opcion[] = [];
  if (node.node_type === "send_buttons") {
    opciones = (node.config as unknown as SendButtonsNodeConfig).buttons ?? [];
  } else if (node.node_type === "send_list") {
    opciones = ((node.config as unknown as SendListNodeConfig).sections ?? []).flatMap((s) => s.rows ?? []);
  } else {
    return null;
  }
  if (opciones.length === 0) return null;
  const t = normalizarRespuesta(texto);
  if (!t) return null;

  // 1. Números contra rangos («87 kilos» → «De 75 a 89 kg»).
  const rangos = opciones.map((o) => rangoDeTitulo(o.title));
  if (rangos.some(Boolean)) {
    const titulos = normalizarRespuesta(opciones.map((o) => o.title).join(" "));
    const unidad = /\bkg\b|kilos/.test(titulos) ? "kg" : /\banos\b|\d+ a \d+|\d+ o mas|menos de \d+$/.test(titulos) ? "anos" : null;
    const num = numeroEscrito(texto, unidad);
    if (num !== null) {
      const hits = opciones.filter((_, i) => rangos[i] && num >= rangos[i]![0] && num <= rangos[i]![1]);
      if (hits.length === 1) return hits[0].next_node_key;
    }
  }

  // 2. El texto de una opción («las dos», «hambre», «hinchazon»).
  const porTitulo = opciones.filter((o) => {
    const tt = normalizarRespuesta(o.title);
    if (!tt) return false;
    if (t === tt) return true;
    if (tt.length >= 4 && t.includes(tt)) return true;
    // «hambre» para «El hambre»: palabra clave de 5+ letras de la opción
    return tt.split(" ").some((p) => p.length >= 5 && !["gracias", "quiero"].includes(p) && t.split(" ").includes(p));
  });
  if (porTitulo.length === 1) return porTitulo[0].next_node_key;

  // 3. Sí / no cortos (sin pregunta, hasta 6 palabras).
  if (/[?¿]/.test(texto) || t.split(" ").length > 6) return null;
  if (node.node_type !== "send_buttons") return null;
  if (NIEGA.test(t) && !AFIRMA.test(t)) {
    const no = opciones.filter((o) => normalizarRespuesta(o.title).startsWith("no"));
    return no.length === 1 ? no[0].next_node_key : null;
  }
  if (AFIRMA.test(t)) {
    const si = opciones.filter((o) => {
      const tt = normalizarRespuesta(o.title);
      return !tt.startsWith("no") && !tt.includes("duda");
    });
    return si.length === 1 ? si[0].next_node_key : null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

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
    node_type === "save_reply"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
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
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
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
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
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
            link: b.media_url!,
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
          link: cfg.media_url,
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
      // cada minuto la retoma (resumeDueRuns). Tope: 23 h.
      const cfg = node.config as unknown as WaitNodeConfig;
      const segundos = Math.min(
        Math.max(Number(cfg.segundos) || 0, 0),
        WAIT_MAX_SEGUNDOS,
      );
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "wait",
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
      const resultado = await enviarEventoMeta({
        accountId: run.account_id,
        contactId: run.contact_id!,
        eventName: cfg.event_name,
        // Un evento por nodo y corrida: Meta deduplica con este id.
        eventId: `${run.id}-${node.node_key}`,
        value: cfg.value,
        currency: cfg.currency,
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
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
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
  if (!cfg.no_contesto_next) return false;
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
  if (!cfg.var_key || !cfg.contesto_next) return false;

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
      if (run.resume_reason === "payment_timeout") {
        if (await resumePaymentTimeout(db, run, now)) retomadas += 1;
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

  // Smart Delay en curso: el flujo sigue siendo dueño de la
  // conversación. El mensaje queda registrado, no cuenta como respuesta
  // equivocada y nadie más contesta (ni la IA): la corrida sigue cuando
  // venza su espera.
  if (
    currentNode.node_type === "wait" ||
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
