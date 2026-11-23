/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}.
   *  Solo se usa en el formato viejo (sin `items`). */
  text: string;
  /**
   * Mensaje compuesto (estilo contenedor multimensaje): burbujas que se
   * mandan en orden. Si existe y tiene elementos, manda en lugar de
   * `text`. Los nodos viejos no lo traen y siguen igual que antes.
   */
  items?: BurbujaMensaje[];
  /** Auto-advance target after the message lands at Meta.
   *  Vacío = fin de rama (la corrida termina limpia). */
  next_node_key: string;
}

export type TipoBurbuja =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "interval";

/** Una burbuja del bloque Mensaje compuesto. */
export interface BurbujaMensaje {
  tipo: TipoBurbuja;
  /** Texto (tipo text) o pie de foto (image/video/document). */
  text?: string;
  /** URL pública del archivo (todo menos text e interval). */
  media_url?: string;
  /** Nombre que ve la clienta (solo document). */
  filename?: string;
  /**
   * text y medios: segundos de «escribiendo…» antes de mandar (0–60).
   * interval: pausa sin «escribiendo…» (1 s – 23 h).
   * Hasta WAIT_INLINE_MAX_SEGUNDOS se espera en el mismo avance; más que
   * eso la corrida se estaciona y la retoma el cron.
   */
  segundos?: number;
  /** Reaccionar con 👍 al último mensaje de la clienta antes de mandar. */
  like?: boolean;
}

/** Tope del «escribiendo…» de una burbuja (el slider va de 0 a 60 s). */
export const BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS = 60;
/** «Escribiendo…» por defecto de cada burbuja nueva. */
export const BURBUJA_ESCRIBIENDO_DEFECTO = 3;
/** Clave reservada en `flow_runs.vars` para retomar un Mensaje a medias. */
export const VAR_CURSOR_BURBUJA = "__burbuja";

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document" | "audio";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
  /** Estado al que pasa la conversación. */
  status?: "pending" | "open" | "closed";
  /** Apaga/enciende la IA de la conversación. */
  pause_ai?: boolean;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * v1.5 ships without runtime validation (`validation` is accepted on
 * the config for forward compat but ignored by the runner); the
 * builder still surfaces the field so users can author flows that
 * v2 will start enforcing.
 */
export type WaitNodeMode = "intervalo" | "fecha" | "horario";

/** Ventana de días/horas hábiles del bloque «Intervalo inteligente». */
export interface WaitSchedule {
  /** Usa `accounts.business_hours` en vez del horario del nodo. */
  usar_cuenta?: boolean;
  /** Zona IANA; si falta, la de la cuenta. */
  timezone?: string;
  /** 1 = lunes … 7 = domingo. */
  dias?: number[];
  /** Hora local de apertura, formato HH:mm. */
  desde?: string;
  /** Hora local de cierre, formato HH:mm. Puede cruzar medianoche. */
  hasta?: string;
}

export interface WaitNodeConfig {
  /**
   * Cuánto esperar antes de seguir con el mensaje siguiente, en
   * segundos (Smart Delay).
   *   - Hasta WAIT_INLINE_MAX_SEGUNDOS (15 s): se espera dentro del
   *     mismo avance, como siempre.
   *   - Más que eso, hasta WAIT_MAX_SEGUNDOS (23 h): la corrida se
   *     estaciona con `flow_runs.next_run_at` y el cron de cada minuto
   *     la retoma. Si al vencer ya se cerró la ventana de 24 h de
   *     WhatsApp, la corrida termina sin mandar nada.
   *
   *   En modo `fecha` u `horario`, `segundos` se ignora y la espera se
   *   calcula al entrar al nodo.
   */
  segundos?: number;
  /** Cómo se programa la espera. Ausente = `intervalo` (compatibilidad). */
  modo?: WaitNodeMode;
  /** Modo `fecha`: instante ISO 8601 con offset. */
  fecha_objetivo?: string;
  /** Modo `horario`: ventana hábil propia o la de la cuenta. */
  horario?: WaitSchedule;
  /**
   * Salida opcional cuando la espera venció fuera de la ventana de
   * servicio de 24 h. Si falta, la corrida termina limpia como antes.
   */
  fuera_ventana_next?: string;
  /** Nodo al que sigue después de la espera. */
  next_node_key: string;
}

export interface SaveReplyNodeConfig {
  /** Texto opcional que se manda antes de quedarse esperando. */
  prompt_text?: string;
  /**
   * Dónde se guarda lo que escriba la clienta:
   * `flow_runs.vars[var_key]`. Se puede usar después con
   * `{{vars.tu_clave}}`.
   */
  var_key: string;
  /** Nodo al que sigue si la clienta contesta. */
  contesto_next: string;
  /** Nodo al que sigue si no contesta dentro de la espera. */
  no_contesto_next: string;
  /**
   * Cuánto esperar antes de darla por no contestada, en minutos.
   * Formato viejo: se sigue escribiendo junto a `espera_segundos` para
   * que el código desplegado antes de este cambio pueda leerlo.
   */
  espera_minutos?: number;
  /** Espera máxima, en segundos (tope duro: 31 días). */
  espera_segundos?: number;
  /**
   * «Esperar indefinidamente»: no hay salida por timeout. Se guarda con
   * `next_run_at` a 31 días como válvula de seguridad, así que el
   * contacto nunca queda bloqueado para siempre.
   */
  esperar_indefinido?: boolean;
  /**
   * Buffer de mensajes: si la clienta manda varios mensajes seguidos,
   * se agrupan durante estos segundos en una sola variable antes de
   * avanzar. 0 o ausente = apagado.
   */
  buffer_segundos?: number;
  /** Cita el mensaje de la clienta en el siguiente bloque de envío. */
  citar_respuesta?: boolean;
  /** Reacciona con 👍 al mensaje de la clienta al capturarlo. */
  reaccionar?: boolean;
  /**
   * Además de `vars.<var_key>`, guarda el texto en el contacto:
   * `custom:<custom_field_id>` o `name` | `email` | `company`.
   * Vacío = no tocar el contacto.
   */
  campo_contacto?: string;
}

/** Tope de la espera configurable (31 días) y válvula del «indefinido». */
export const ESPERA_MAX_SEGUNDOS = 31 * 24 * 3600;
/** Tope del buffer de mensajes de «Esperar respuesta». */
export const BUFFER_MAX_SEGUNDOS = 120;
/** Clave reservada en `flow_runs.vars` con el wamid a citar. */
export const VAR_REPLY_TO = "__reply_to";
/** Clave reservada en `flow_runs.vars` con el buffer en curso. */
export const VAR_BUFFER = "__buffer";

/** Estado del buffer de mensajes mientras la corrida espera. */
export interface BufferRespuesta {
  nodo: string;
  /** ISO del primer mensaje; la ventana no se desliza. */
  inicio: string;
  /** Textos en orden de llegada. */
  textos: string[];
  /** wamid del primer mensaje (para la cita y la reacción). */
  reply_to?: string | null;
}

export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Reserved for v2. Accepted on the config but ignored by the v1.5
   * runner — captures any non-empty text.
   */
  validation?: "any" | "email" | "phone" | "regex";
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";

export type ConditionSubject = "var" | "tag" | "contact_field";

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionRule {
  id: string;
  subject: ConditionSubject;
  /** var key, tag UUID or contact field. */
  subject_key: string;
  operator: ConditionOperator;
  value?: string;
}

export interface ConditionNodeConfig {
  /** Todas (Y) o cualquiera (O). Los flujos viejos no lo traen: Y. */
  logic?: "all" | "any";
  rules?: ConditionRule[];
  /** Formato viejo de una sola regla (compatibilidad). */
  subject: ConditionSubject;
  subject_key: string;
  operator: ConditionOperator;
  value?: string;
  true_next: string;
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Varias etiquetas; `tag_id` se conserva por compatibilidad. */
  tag_ids?: string[];
  tag_id: string;
  next_node_key: string;
}

/**
 * Dispara un evento de la API de conversiones para mensajes (Meta CAPI,
 * business_messaging) ligado al clic del anuncio de la clienta
 * (`ctwa_clid`). Sin clic de anuncio no se manda nada y el flujo sigue.
 * Nunca frena el flujo: si Meta falla, se anota y avanza.
 */
export type MetaCapiEventName =
  | "Purchase"
  | "Lead"
  | "InitiateCheckout"
  | "AddToCart"
  | "ViewContent";

export const META_CAPI_EVENTOS: readonly MetaCapiEventName[] = [
  "Purchase",
  "Lead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
];

export interface MetaCapiNodeConfig {
  event_name: MetaCapiEventName;
  /** Monto del evento (obligatorio en Purchase). */
  value?: number;
  /** Moneda ISO; por defecto MXN. */
  currency?: string;
  /** Píxel/dataset de la cuenta; si falta, el activo más antiguo. */
  pixel_id?: string;
  /** Page ID opcional, con variables {{...}}. */
  page_id?: string;
  /** Valor fijo o tomado de una variable. */
  value_mode?: "fixed" | "variable";
  value_var?: string;
  next_node_key: string;
}

/** Transfiere la corrida a otro flujo activo de la cuenta. */
export interface ConnectFlowNodeConfig {
  target_flow_id: string;
}

export interface AiBlockCondition {
  id: string;
  label: string;
  next_node_key: string;
}

/**
 * Bloque de IA (DeepSeek): prompt + comprensión de audio/imagen/PDF,
 * comprobante, condicionales inteligentes y contexto.
 */
export interface AiBlockNodeConfig {
  credential_source?: "account" | "flow";
  model?: string;
  message_template?: string;
  output_var?: string;
  auto_send?: boolean;
  prompt?: string;
  understand_audio?: boolean;
  understand_image?: boolean;
  understand_pdf?: boolean;
  identify_receipt?: boolean;
  context_window?: number;
  conditions?: AiBlockCondition[];
  receipt_next?: string;
  fallback_next: string;
}

/**
 * Botón Pago / SPEI (migración 079). Manda los datos SPEI y se queda
 * esperando el comprobante (imagen o PDF). La IA lo lee y lo valida
 * contra el monto y la CLABE de ESTE nodo:
 *   - válido            → `aprobado_next` (y pone `etiqueta_al_aprobar`)
 *   - no coincide / vence → `rechazado_next`
 *   - no es comprobante → le pide la captura y sigue esperando.
 * Campos vacíos se completan con `payment_details` de la cuenta.
 */
export interface SendPaymentNodeConfig {
  clabe?: string;
  beneficiario?: string;
  banco?: string;
  /** Monto esperado en MXN. */
  monto: number;
  referencia?: string;
  /** Texto opcional antes de los datos (por defecto, uno corto). */
  mensaje?: string;
  /** Regla de Julián: venta sin botones. Apagado salvo que se encienda. */
  con_boton: boolean;
  /** Cuánto esperar el comprobante (tope 23 h). */
  espera_minutos: number;
  /** Etiqueta al aprobar; por defecto «pagado» (dispara CAPI y entregas). */
  etiqueta_al_aprobar?: string;
  aprobado_next: string;
  rechazado_next: string;
}

/** Template WhatsApp (079): plantilla APPROVED de Meta con variables. */
export interface SendTemplateNodeConfig {
  template_name: string;
  language: string;
  /**
   * Valor de cada {{n}} del cuerpo: texto fijo o fichas como
   * {{contact.name}}, {{custom.campo}} o {{vars.clave}}.
   */
  variables: Record<string, string>;
  next_node_key: string;
}

/** Kanban (079): mueve el trato del contacto a una etapa del tablero. */
export interface MoveKanbanNodeConfig {
  pipeline_id: string;
  stage_id: string;
  /** Si el contacto no tiene trato abierto en ese embudo, se crea. */
  crear_si_no_existe: boolean;
  /** Título del trato nuevo (admite fichas); por defecto, el nombre. */
  titulo?: string;
  next_node_key: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "wait"; config: WaitNodeConfig }
  | { node_type: "save_reply"; config: SaveReplyNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "meta_capi"; config: MetaCapiNodeConfig }
  | { node_type: "send_payment"; config: SendPaymentNodeConfig }
  | { node_type: "send_template"; config: SendTemplateNodeConfig }
  | { node_type: "move_kanban"; config: MoveKanbanNodeConfig }
  | { node_type: "connect_flow"; config: ConnectFlowNodeConfig }
  | { node_type: "ai_block"; config: AiBlockNodeConfig }
  | { node_type: "manipulator"; config: ManipulatorNodeConfig }
  | { node_type: "distributor"; config: DistributorNodeConfig }
  | { node_type: "notification"; config: NotificationNodeConfig }
  | { node_type: "sale_approved"; config: SaleApprovedNodeConfig }
  | { node_type: "carousel"; config: CarouselNodeConfig }
  | { node_type: "department"; config: DepartmentNodeConfig }
  | { node_type: "http_request"; config: HttpRequestNodeConfig }
  | { node_type: "payment_gateway"; config: PaymentGatewayNodeConfig }
  | { node_type: "ai_media"; config: AiMediaNodeConfig }
  | { node_type: "official_call"; config: OfficialCallNodeConfig }
  | { node_type: "end"; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  match_type?: "exact" | "contains";
  case_sensitive?: boolean;
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "any_message"; config: Record<string, never> }
  | { trigger_type: "manual"; config: Record<string, never> };

/**
 * «Cualquier mensaje»: se dispara como mucho una vez por contacto en
 * esta ventana, para que al terminar el flujo el chat quede para la IA
 * y no se repita en bucle (decisión de Julián, 22-nov-2026).
 */
export const ANY_MESSAGE_COOLDOWN_MS = 24 * 3600 * 1000;

/** Nodos de una sola salida: sin conexión = fin de rama (no es error). */
export const NODOS_FIN_DE_RAMA: ReadonlySet<string> = new Set([
  "send_message",
  "send_media",
  "wait",
  "set_tag",
  "meta_capi",
  "send_template",
  "move_kanban",
  "department",
  "http_request",
  "ai_media",
]);

// ============================================================
// DB-row shapes (read by the engine via supabaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "any_message" | "manual";
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  /** Isla que escucha; null = todas las conexiones (migración 089). */
  connection_id?: string | null;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "cancelled"
    | "failed";
  current_node_key: string | null;
  transition_seq: number;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /** Migración 077: cuándo la retoma el cron (null = no está estacionada). */
  next_run_at?: string | null;
  resume_reason?:
    | "delay"
    | "reply_timeout"
    | "payment_timeout"
    | "reply_buffer"
    | "awaiting_reply"
    | "carousel_timeout"
    | "payment_gateway"
    | "call_permission"
    | null;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
}

export const MAX_FLOW_TIMEOUT_HOURS = 87600;

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
    }
  | {
      /**
       * Imagen o documento (migración 079). Lo usa el nodo Botón Pago /
       * SPEI para leer el comprobante. Para cualquier otro nodo se trata
       * igual que antes: como texto con su pie de foto (`text`).
       */
      kind: "media";
      media_type: "image" | "document";
      media_id: string;
      mime_type: string;
      /** Pie de foto o nombre del archivo, como lo guardaba el webhook. */
      text: string;
      meta_message_id: string;
    }
  | {
      /**
       * Respuesta a una solicitud oficial de permiso de llamada
       * (`call_permission_reply`). No es un botón normal: la maneja el
       * bloque `official_call`.
       */
      kind: "call_permission";
      response: "accept" | "reject";
      is_permanent: boolean;
      expiration_timestamp?: number | null;
      /** wamid del mensaje de permiso que originó la respuesta. */
      context_id?: string | null;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  /** Conexión de WhatsApp de la conversación (migración 089). */
  connectionId?: string | null;
  message: ParsedInbound;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    /** La corrida está en un Smart Delay: el mensaje se queda en el flujo. */
    | "waiting"
    | "run_error"
    | "no_match";
  /**
   * El flujo que atendió el mensaje. Lo usa el webhook para respetar la
   * configuración del flujo (p. ej. `extra_para_ia`), sin tener que
   * volver a consultarlo.
   */
  flow?: FlowRow;
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export const AUTO_ADVANCING_NODE_TYPES: ReadonlySet<string> = new Set([
  "start",
  "send_message",
  "send_media",
  "condition",
  "set_tag",
  "wait",
  "meta_capi",
  "send_template",
  "move_kanban",
  "department",
  "http_request",
  "ai_media",
]);

/** Smart Delay: hasta aquí se espera en el mismo avance (15 s, para el «escribiendo…»). Más que eso nunca ocupa el webhook: lo retoma el cron. */
export const WAIT_INLINE_MAX_SEGUNDOS = 15;
/** Smart Delay: tope total (23 h), para no salir de la ventana de 24 h. */
export const WAIT_MAX_SEGUNDOS = 23 * 3600;
/** Espera programada (fecha/horario): tope de 31 días. */
export const WAIT_PROGRAMADO_MAX_SEGUNDOS = 31 * 24 * 3600;

/** Integración HTTP: timeout y tamaño máximo de respuesta. */
export const HTTP_TIMEOUT_MS = 15_000;
export const HTTP_TIMEOUT_MAX_MS = 30_000;
export const HTTP_RESPONSE_MAX_BYTES = 256 * 1024;
/** Cabeceras de la respuesta que se guardan al probar (vista previa). */
export const HTTP_TEST_MAX_BYTES = 16 * 1024;

/** Pasarela: espera máxima de 30 días y lista cerrada de proveedores. */
export const PAYMENT_GATEWAY_MAX_MINUTOS = 30 * 24 * 60;
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  "hotmart",
  "whop",
  "mercadopago",
  "stripe",
  "spei",
];
export const PAYMENT_CURRENCIES: readonly PaymentCurrency[] = ["MXN", "USD"];

/** Claves reservadas de la corrida para pagos y llamadas. */
export const VAR_PAYMENT_REF = "__payment_ref";
export const VAR_PAYMENT_SESSION = "__payment_session";
export const VAR_PAYMENT_STATUS = "__payment_status";
export const VAR_CALL_SESSION = "__call_session";

/** Llamada oficial: espera máxima del permiso. */
export const CALL_PERMISSION_MAX_DIAS = 7;
/** Países donde Meta no permite llamadas iniciadas por el negocio. */
export const OFFICIAL_CALL_EXCLUDED_COUNTRIES: readonly string[] = [
  "US",
  "CA",
  "EG",
  "VN",
  "NG",
];

/** Voces Edge-TTS en español mexicano. */
export const AI_MEDIA_EDGE_VOICES = [
  { id: "es-MX-DaliaNeural", label: "Dalia (femenina)" },
  { id: "es-MX-JorgeNeural", label: "Jorge (masculina)" },
] as const;
export const AI_MEDIA_AUDIO_PROVIDERS: readonly AiAudioProvider[] = [
  "edge",
  "openai",
];
export const AI_MEDIA_IMAGE_PROVIDERS: readonly AiImageProvider[] = [
  "pollinations",
  "together",
  "flux",
  "openai",
];
/**
 * Ventana de servicio de WhatsApp con margen: pasado este tiempo desde el
 * último mensaje de la clienta, el flujo ya no manda mensajes libres.
 */
export const VENTANA_SERVICIO_MS = 23.5 * 3600 * 1000;

export const MAX_NODES_PER_ADVANCE = 25;

export const MAX_AUTO_ADVANCING_CHAIN = MAX_NODES_PER_ADVANCE - 1;

export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}

export interface ManipulatorNodeConfig {
  target: 'var' | 'contact_field';
  key: string;
  operation: 'set' | 'add' | 'subtract' | 'clear';
  value?: string;
  value_type?: 'text' | 'number';
  next_node_key: string;
}

export interface DistributorOutput {
  id: string;
  label: string;
  next_node_key: string;
}

export interface DistributorNodeConfig {
  mode: 'always_next' | 'avoid_repeat';
  outputs: DistributorOutput[];
}

export interface NotificationNodeConfig {
  name: string;
  country_code?: string;
  phone: string;
  message: string;
  next_node_key?: string;
}

export interface SaleApprovedNodeConfig {
  pipeline_id: string;
  stage_id: string;
  product_id?: string;
  name_var?: string;
  amount_var: string;
  currency_var?: string;
  send_capi?: boolean;
  notify?: boolean;
  next_node_key?: string;
}

export interface CarouselButtonConfig {
  id: string;
  label: string;
  type: 'reply' | 'url';
  url?: string;
  next_node_key?: string;
}

export interface CarouselCardConfig {
  id: string;
  text: string;
  image_url?: string;
  buttons: CarouselButtonConfig[];
}

export interface CarouselNodeConfig {
  intro_text?: string;
  expires_days: number;
  cards: CarouselCardConfig[];
  timeout_next?: string;
}

// ============================================================
// Bloques finales (migración 095)
// ============================================================

/** Asigna el chat a un departamento configurado en la cuenta. */
export interface DepartmentNodeConfig {
  department_id: string;
  /** Copia para el resumen del lienzo; no es la fuente de verdad. */
  department_name?: string;
  next_node_key: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type HttpBodyType = "none" | "json" | "form" | "raw";

export interface HttpHeader {
  key: string;
  value: string;
}

export interface HttpResponseMap {
  /** Ruta JSON, p. ej. `data.items[0].id`. */
  path: string;
  /** Clave de `flow_runs.vars` donde se guarda. */
  var_key: string;
}

/**
 * Integración HTTP. La URL, headers y body admiten fichas:
 * `{{vars.x}}`, `{{contact.name}}`, `{{custom.campo}}` y
 * `{{credential.nombre}}` (esta última se resuelve en el servidor).
 */
export interface HttpRequestNodeConfig {
  method: HttpMethod;
  url: string;
  headers: HttpHeader[];
  body_type: HttpBodyType;
  body?: string;
  timeout_ms?: number;
  /** Credencial cifrada de `flow_credentials` para Authorization. */
  credential_id?: string;
  /** Nombre visible de la credencial (solo resumen). */
  credential_name?: string;
  response_map: HttpResponseMap[];
  /** Guarda el código HTTP en `vars.<status_var>`. */
  status_var?: string;
  /** Si falla, sigue por `next_node_key` en vez de terminar. */
  continue_on_error?: boolean;
  error_next?: string;
  next_node_key: string;
}

export type PaymentProvider =
  | "hotmart"
  | "whop"
  | "mercadopago"
  | "stripe"
  | "spei";

export type PaymentCurrency = "MXN" | "USD";
export type PaymentAmountMode = "fixed" | "variable";

/**
 * Pasarela de pagos. Manda el checkout (o los datos SPEI) y estaciona
 * la corrida hasta que el webhook —o la confirmación manual— la
 * despierta.
 */
export interface PaymentGatewayNodeConfig {
  provider: PaymentProvider;
  currency: PaymentCurrency;
  amount_mode: PaymentAmountMode;
  amount?: number;
  amount_var?: string;
  concept?: string;
  /** Enlace/checkout. Admite {{payment_ref}}, {{amount}}, {{currency}}. */
  checkout_url?: string;
  /** Texto que acompaña al enlace (o a los datos SPEI). */
  message?: string;
  /** Plantilla de respaldo si la ventana de 24 h está cerrada. */
  template_name?: string;
  template_language?: string;
  template_variables?: Record<string, string>;
  /** Espera máxima; 5 min – 30 días. */
  wait_minutes: number;
  approved_next: string;
  rejected_next?: string;
  timeout_next?: string;
  etiqueta_al_aprobar?: string;
  pipeline_id?: string;
  stage_id?: string;
  product_id?: string;
  send_capi?: boolean;
  notify?: boolean;
}

export type AiMediaKind = "audio" | "image";
export type AiAudioProvider = "edge" | "openai";
export type AiImageProvider = "pollinations" | "together" | "flux" | "openai";

export interface AiMediaAudioConfig {
  provider: AiAudioProvider;
  /** Voz Edge-TTS o voz OpenAI. */
  voice: string;
  /** Texto a sintetizar; admite fichas. */
  text: string;
  /** `ogg` intenta nota de voz; si el proveedor no lo da, cae a mp3. */
  format?: "mp3" | "ogg";
}

export interface AiMediaImageConfig {
  provider: AiImageProvider;
  prompt: string;
  /** Reescribe el prompt con DeepSeek antes de generar. */
  enhance_prompt?: boolean;
  width?: number;
  height?: number;
  model?: string;
}

/** Genera audio/imagen y guarda la URL en `vars.<output_var>`. */
export interface AiMediaNodeConfig {
  kind: AiMediaKind;
  audio?: AiMediaAudioConfig;
  image?: AiMediaImageConfig;
  /** Por defecto `ai_media_url`. */
  output_var?: string;
  /** Envía el medio en este mismo nodo (además de guardar la URL). */
  send_now?: boolean;
  next_node_key: string;
}

export type OfficialCallMode = "permission" | "call";
export type OfficialCallBridge = "none" | "sip";

/**
 * Llamada oficial: solicita permiso con la WhatsApp Business Calling
 * API. `mode="call"` solo dispara una llamada si la cuenta tiene un
 * puente SIP configurado; nunca usa vías no oficiales.
 */
export interface OfficialCallNodeConfig {
  mode: OfficialCallMode;
  body_text: string;
  template_name?: string;
  template_language?: string;
  template_variables?: Record<string, string>;
  /** Días que se espera la respuesta del permiso (1–7). */
  wait_days?: number;
  granted_next: string;
  denied_next?: string;
  timeout_next?: string;
  call_bridge?: OfficialCallBridge;
}
