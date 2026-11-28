/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";

/**
 * Cuenta caracteres como los cuenta WhatsApp (puntos de código), no como
 * unidades UTF-16.
 *
 * Las negritas de adorno que se usan en los embudos (𝗔, 𝐀, 𝘀) viven
 * fuera del plano básico: en JavaScript cada una ocupa 2 unidades, así
 * que un texto de 897 caracteres se medía como 1116 y el validador lo
 * marcaba como «supera los 1024» aunque Meta lo acepta sin problema.
 */
export function cuentaCaracteres(texto: string): number {
  return Array.from(texto).length;
}
import { getT } from "@/lib/i18n/translate";
import {
  AUTO_ADVANCING_NODE_TYPES,
  BUFFER_MAX_SEGUNDOS,
  BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS,
  ESPERA_MAX_SEGUNDOS,
  MAX_AUTO_ADVANCING_CHAIN,
  META_CAPI_EVENTOS,
  PAYMENT_GATEWAY_MAX_MINUTOS,
  WAIT_MAX_SEGUNDOS,
} from "./types";

const t = getT("Validation.flows");

export interface ValidationIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
}

interface FlowInput {
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "any_message" | "manual";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "name",
      message: t("nameRequired"),
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: t("entryRequired"),
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: "error",
      scope: "flow",
      message: t("needsNode"),
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: t("entryMissing", { id: flow.entry_node_id }),
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: "error",
        scope: "node",
        node_key: n.node_key,
        message: t("duplicateNodeKey", { key: n.node_key }),
      });
    }
    seen.add(n.node_key);
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  for (const n of nodes) {
    issues.push(...validateNode(n, keys));
  }

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          message: t("unreachable", { key: n.node_key }),
        });
      }
    }
  }

  for (const cycle of findAutoAdvancingCycles(nodes)) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: cycle[0],
      message: t("autoAdvanceCycle", { keys: cycle.join(", ") }),
    });
  }

  const longestChain = longestAutoAdvancingChain(nodes);
  if (longestChain && longestChain.length > MAX_AUTO_ADVANCING_CHAIN) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: longestChain.start,
      message: t("autoAdvanceChainTooLong", {
        key: longestChain.start,
        count: longestChain.length,
        max: MAX_AUTO_ADVANCING_CHAIN,
      }),
    });
  }

  return issues;
}

export function longestAutoAdvancingChain(
  nodes: NodeInput[],
): { start: string; length: number } | null {
  const autoNodes = new Map<string, NodeInput>();
  for (const n of nodes) {
    if (AUTO_ADVANCING_NODE_TYPES.has(n.node_type) && !autoNodes.has(n.node_key)) {
      autoNodes.set(n.node_key, n);
    }
  }
  const chainLength = new Map<string, number>();
  const inProgress = new Set<string>();
  const lengthFrom = (key: string): number => {
    const known = chainLength.get(key);
    if (known !== undefined) return known;
    if (inProgress.has(key)) return 0;
    inProgress.add(key);
    let longestNext = 0;
    for (const next of outgoingEdges(autoNodes.get(key)!)) {
      if (autoNodes.has(next)) longestNext = Math.max(longestNext, lengthFrom(next));
    }
    inProgress.delete(key);
    chainLength.set(key, longestNext + 1);
    return longestNext + 1;
  };

  let longest: { start: string; length: number } | null = null;
  for (const key of autoNodes.keys()) {
    const length = lengthFrom(key);
    if (!longest || length > longest.length) longest = { start: key, length };
  }
  return longest;
}

export function findAutoAdvancingCycles(nodes: NodeInput[]): string[][] {
  const autoNodes = new Map<string, NodeInput>();
  for (const n of nodes) {
    if (AUTO_ADVANCING_NODE_TYPES.has(n.node_type) && !autoNodes.has(n.node_key)) {
      autoNodes.set(n.node_key, n);
    }
  }
  const successors = (key: string): string[] =>
    outgoingEdges(autoNodes.get(key)!).filter((next) => autoNodes.has(next));

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (key: string): void => {
    index.set(key, counter);
    lowLink.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const next of successors(key)) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(key, Math.min(lowLink.get(key)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(key, Math.min(lowLink.get(key)!, index.get(next)!));
      }
    }
    if (lowLink.get(key) !== index.get(key)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== key);
    if (component.length > 1 || successors(key).includes(key)) {
      const inNodeOrder = [...autoNodes.keys()].filter((k) => component.includes(k));
      cycles.push(inNodeOrder);
    }
  };

  for (const key of autoNodes.keys()) {
    if (!index.has(key)) visit(key);
  }
  return cycles;
}

// ============================================================
// Trigger
// ============================================================

function validateTrigger(
  trigger_type: FlowInput["trigger_type"],
  trigger_config: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (trigger_type === "keyword") {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: "trigger_config.keywords",
        message: t("keywordsRequired"),
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== "string" || !k.trim(),
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: "warning",
          scope: "trigger",
          field: "trigger_config.keywords",
          message: t("blankKeywords", { count: blanks }),
        });
      }
    }
  }
  // first_inbound_message / any_message / manual have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

const TIPOS_BURBUJA = ["text", "image", "video", "audio", "document", "sticker", "interval"];

/** Burbujas del Mensaje compuesto: contenido y rangos de tiempo. */
function validarBurbujas(
  node_key: string,
  items: Array<Record<string, unknown>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (field: string, message: string) =>
    issues.push({ severity: "error", scope: "node", node_key, field, message });
  items.forEach((b, i) => {
    const tipo = String(b.tipo ?? "");
    const n = i + 1;
    if (!TIPOS_BURBUJA.includes(tipo)) {
      error(`items.${i}.tipo`, t("bubbleNeedsType", { n }));
      return;
    }
    const segundos = b.segundos === undefined ? null : Number(b.segundos);
    if (tipo === "interval") {
      if (segundos === null || !Number.isFinite(segundos) || segundos < 1 || segundos > WAIT_MAX_SEGUNDOS) {
        error(`items.${i}.segundos`, t("bubbleIntervalRange", { n }));
      }
      return;
    }
    if (tipo === "text") {
      if (!String(b.text ?? "").trim()) error(`items.${i}.text`, t("bubbleNeedsText", { n }));
    } else {
      if (!String(b.media_url ?? "").trim()) error(`items.${i}.media_url`, t("bubbleNeedsFile", { n }));
      if (
        typeof b.text === "string" &&
        cuentaCaracteres(b.text) > INTERACTIVE_LIMITS.bodyMaxLength
      ) {
        error(`items.${i}.text`, t("captionTooLong", { max: INTERACTIVE_LIMITS.bodyMaxLength }));
      }
    }
    if (
      segundos !== null &&
      (!Number.isFinite(segundos) || segundos < 0 || segundos > BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS)
    ) {
      error(`items.${i}.segundos`, t("bubbleTypingRange", { n, max: BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS }));
    }
  });
  return issues;
}

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case "start": {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("startNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("startMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_message": {
      const cfg = node.config as {
        text?: string;
        items?: Array<Record<string, unknown>>;
        next_node_key?: string;
      };
      const compuesto = Array.isArray(cfg.items) && cfg.items.length > 0;
      if (compuesto) issues.push(...validarBurbujas(node.node_key, cfg.items!));
      if (!compuesto && !cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendMessageNeedsText"),
        });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMessageMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_media": {
      const cfg = node.config as {
        media_type?: "image" | "video" | "document" | "audio";
        media_url?: string;
        caption?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !["image", "video", "document", "audio"].includes(cfg.media_type)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_type",
          message: t("sendMediaNeedsType"),
        });
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_url",
          message: t("sendMediaNeedsFile"),
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (cfg.caption && cuentaCaracteres(cfg.caption) > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "caption",
          message: t("captionTooLong", { max: INTERACTIVE_LIMITS.bodyMaxLength }),
        });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMediaMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_buttons": {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendButtonsNeedsText"),
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: t("sendButtonsNeedsButton"),
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: t("tooManyButtons", { max: INTERACTIVE_LIMITS.maxButtons }),
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: t("buttonNeedsReplyId", { n: i + 1 }),
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: t("duplicateButtonReplyId", { id: b.reply_id }),
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: t("buttonNeedsTitle", { n: i + 1 }),
          });
        } else if (cuentaCaracteres(b.title) > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: t("buttonTitleTooLong", {
              n: i + 1,
              max: INTERACTIVE_LIMITS.buttonTitleMaxLength,
            }),
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: t("buttonNeedsNext", { n: i + 1 }),
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: t("buttonMissingNext", { n: i + 1, key: b.next_node_key }),
          });
        }
      });
      break;
    }

    case "send_list": {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendListNeedsText"),
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_label",
          message: t("sendListNeedsLabel"),
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0,
      );
      if (totalRows < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: t("sendListNeedsRow"),
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: t("tooManyRows", { max: INTERACTIVE_LIMITS.maxListRowsTotal }),
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: t("rowNeedsReplyId", { row: ri + 1, section: si + 1 }),
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: t("duplicateRowId", { id: row.reply_id }),
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: t("rowNeedsTitle", { n: ri + 1 }),
            });
          } else if (
            cuentaCaracteres(row.title) > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: t("rowTitleTooLong", {
                n: ri + 1,
                max: INTERACTIVE_LIMITS.listRowTitleMaxLength,
              }),
            });
          }
          if (
            row.description &&
            cuentaCaracteres(row.description) >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.description`,
              message: t("rowDescriptionTooLong", {
                n: ri + 1,
                max: INTERACTIVE_LIMITS.listRowDescriptionMaxLength,
              }),
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: t("rowNeedsNext", { n: ri + 1 }),
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: t("rowMissingNext", { n: ri + 1, key: row.next_node_key }),
            });
          }
        });
      });
      break;
    }

    case "collect_input": {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "prompt_text",
          message: t("collectNeedsPrompt"),
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: t("collectNeedsVarKey"),
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: t("invalidVarKey", { key: cfg.var_key }),
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("collectNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("collectMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "wait": {
      const cfg = node.config as {
        segundos?: number;
        modo?: "intervalo" | "fecha" | "horario";
        fecha_objetivo?: string;
        horario?: { dias?: number[]; desde?: string; hasta?: string; usar_cuenta?: boolean };
        fuera_ventana_next?: string;
        next_node_key?: string;
      };
      const modo = cfg.modo ?? "intervalo";
      if (modo === "intervalo") {
        const segundos = Number(cfg.segundos);
        if (!Number.isFinite(segundos) || segundos < 1 || segundos > WAIT_MAX_SEGUNDOS) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "segundos",
            message: t("waitSecondsRange"),
          });
        }
      } else if (modo === "fecha") {
        const fecha = cfg.fecha_objetivo ? new Date(cfg.fecha_objetivo) : null;
        if (!fecha || Number.isNaN(fecha.getTime())) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "fecha_objetivo",
            message: t("waitNeedsDate"),
          });
        }
      } else if (modo === "horario") {
        const dias = cfg.horario?.dias ?? [1, 2, 3, 4, 5];
        const desde = cfg.horario?.desde;
        const hasta = cfg.horario?.hasta;
        if (dias.length === 0 || !desde || !hasta) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "horario",
            message: t("waitNeedsSchedule"),
          });
        }
      }
      if (modo !== "intervalo" && !cfg.fuera_ventana_next) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "fuera_ventana_next",
          message: t("waitOutsideWindow"),
        });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("waitMissingNext", { key: cfg.next_node_key }),
        });
      }
      if (cfg.fuera_ventana_next && !knownKeys.has(cfg.fuera_ventana_next)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "fuera_ventana_next",
          message: t("waitMissingNext", { key: cfg.fuera_ventana_next }),
        });
      }
      break;
    }

    case "send_payment": {
      const cfg = node.config as {
        clabe?: string;
        monto?: number;
        espera_minutos?: number;
        aprobado_next?: string;
        rechazado_next?: string;
      };
      if (!(Number(cfg.monto) > 0)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "monto", message: t("paymentNeedsAmount") });
      }
      const clabe = (cfg.clabe ?? "").replace(/\s+/g, "");
      if (clabe && !/^\d{18}$/.test(clabe)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "clabe", message: t("paymentClabeFormat") });
      } else if (!clabe) {
        // Puede salir de «Datos de pago» de la cuenta: solo se avisa.
        issues.push({ severity: "warning", scope: "node", node_key: node.node_key, field: "clabe", message: t("paymentClabeFromAccount") });
      }
      const espera = Number(cfg.espera_minutos);
      if (!Number.isFinite(espera) || espera < 1 || espera > 23 * 60) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "espera_minutos", message: t("paymentWaitRange") });
      }
      for (const [campo, valor] of [
        ["aprobado_next", cfg.aprobado_next],
        ["rechazado_next", cfg.rechazado_next],
      ] as const) {
        if (!valor) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: campo, message: t("paymentNeedsBothBranches") });
        } else if (!knownKeys.has(valor)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: campo, message: t("paymentMissingBranch", { key: valor }) });
        }
      }
      break;
    }

    case "send_template":
    case "move_kanban": {
      const cfg = node.config as {
        template_name?: string;
        pipeline_id?: string;
        stage_id?: string;
        next_node_key?: string;
      };
      if (node.node_type === "send_template" && !cfg.template_name?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "template_name", message: t("templateNeedsName") });
      }
      if (node.node_type === "move_kanban" && (!cfg.pipeline_id || !cfg.stage_id)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "stage_id", message: t("kanbanNeedsStage") });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("blockMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }

    case "meta_capi": {
      const cfg = node.config as {
        event_name?: string;
        value?: number;
        value_mode?: "fixed" | "variable";
        value_var?: string;
        next_node_key?: string;
      };
      if (
        !cfg.event_name ||
        !(META_CAPI_EVENTOS as readonly string[]).includes(cfg.event_name)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "event_name",
          message: t("metaCapiNeedsEvent"),
        });
      }
      const valor = Number(cfg.value);
      if (
        cfg.event_name === "Purchase" &&
        cfg.value_mode !== "variable" &&
        (!Number.isFinite(valor) || valor <= 0)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "value",
          message: t("metaCapiPurchaseNeedsValue"),
        });
      }
      if (cfg.event_name === "Purchase" && cfg.value_mode === "variable" && !cfg.value_var?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "value_var",
          message: t("metaCapiPurchaseNeedsValue"),
        });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("metaCapiMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "save_reply": {
      const cfg = node.config as {
        var_key?: string;
        espera_minutos?: number;
        espera_segundos?: number;
        esperar_indefinido?: boolean;
        buffer_segundos?: number;
        contesto_next?: string;
        no_contesto_next?: string;
        campo_contacto?: string;
      };
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: t("saveReplyNeedsVar"),
        });
      }
      const espera =
        typeof cfg.espera_segundos === "number" && Number.isFinite(cfg.espera_segundos)
          ? cfg.espera_segundos
          : Number(cfg.espera_minutos) * 60;
      if (!cfg.esperar_indefinido) {
        if (!Number.isFinite(espera) || espera < 1) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "espera_segundos",
            message: t("saveReplyNeedsWait"),
          });
        } else if (espera > ESPERA_MAX_SEGUNDOS) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "espera_segundos",
            message: t("saveReplyWaitTooLong", { max: 31 }),
          });
        } else if (espera > 23 * 3600) {
          // Se permite, pero fuera de la ventana de 24 h de WhatsApp la
          // rama de «no contesta» no podrá mandar mensajes libres.
          issues.push({
            severity: "warning",
            scope: "node",
            node_key: node.node_key,
            field: "espera_segundos",
            message: t("saveReplyWaitOutsideWindow"),
          });
        }
      }
      const buffer = Number(cfg.buffer_segundos) || 0;
      if (buffer < 0 || buffer > BUFFER_MAX_SEGUNDOS) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buffer_segundos",
          message: t("saveReplyBufferRange", { max: BUFFER_MAX_SEGUNDOS }),
        });
      }
      const ramas: ReadonlyArray<readonly [string, string | undefined]> = cfg.esperar_indefinido
        ? ([["contesto_next", cfg.contesto_next]] as const)
        : ([
            ["contesto_next", cfg.contesto_next],
            ["no_contesto_next", cfg.no_contesto_next],
          ] as const);
      for (const [campo, valor] of ramas) {
        // Como en Leona: «si no responde» puede quedar sin conectar; al
        // vencerse la espera la conversación termina ahí (aviso, no error).
        if (!valor) {
          issues.push({
            severity: "warning",
            scope: "node",
            node_key: node.node_key,
            field: campo,
            message: t(campo === "no_contesto_next" ? "saveReplyTimeoutEnds" : "saveReplyReplyEnds"),
          });
          continue;
        }
        if (!valor) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: campo,
            message: t("saveReplyNeedsBothBranches"),
          });
        } else if (!knownKeys.has(valor)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: campo,
            message: t("saveReplyMissingBranch", { key: valor }),
          });
        }
      }
      break;
    }

    case "condition": {
      const cfg = node.config as {
        subject?: "var" | "tag" | "contact_field";
        subject_key?: string;
        operator?: "equals" | "contains" | "present" | "absent";
        value?: string;
        true_next?: string;
        false_next?: string;
      };
      if (!cfg.subject || !["var", "tag", "contact_field"].includes(cfg.subject)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject",
          message: t("conditionNeedsSubject"),
        });
      }
      if (!cfg.subject_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject_key",
          message: t("conditionNeedsSubjectKey"),
        });
      }
      if (
        !cfg.operator ||
        !["equals", "contains", "present", "absent"].includes(cfg.operator)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "operator",
          message: t("conditionNeedsOperator"),
        });
      } else if (
        (cfg.operator === "equals" || cfg.operator === "contains") &&
        (cfg.value === undefined || cfg.value === "")
      ) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "value",
          message: t("operatorNeedsValue", { operator: cfg.operator }),
        });
      }
      for (const branch of ["true_next", "false_next"] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: t("conditionNeedsBranch", {
              branch: branch === "true_next" ? "true" : "false",
            }),
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: t("conditionMissingBranch", { branch, key }),
          });
        }
      }
      break;
    }

    case "set_tag": {
      const cfg = node.config as {
        mode?: "add" | "remove";
        tag_id?: string;
        tag_ids?: string[];
        next_node_key?: string;
      };
      if (!cfg.mode || !["add", "remove"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: t("setTagNeedsMode"),
        });
      }
      if (!cfg.tag_id && (!cfg.tag_ids || cfg.tag_ids.length === 0)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "tag_id",
          message: t("setTagNeedsTag"),
        });
      }
      // Sin conexión = fin de rama: la corrida termina limpia (no es error).
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("setTagMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "connect_flow": {
      const cfg = node.config as { target_flow_id?: string };
      if (!cfg.target_flow_id?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "target_flow_id",
          message: t("connectFlowNeedsTarget"),
        });
      }
      break;
    }

    case "ai_block": {
      const cfg = node.config as {
        fallback_next?: string;
        receipt_next?: string;
        identify_receipt?: boolean;
        context_window?: number;
        conditions?: Array<{ id?: string; label?: string; next_node_key?: string }>;
      };
      if (cfg.fallback_next && !knownKeys.has(cfg.fallback_next)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "fallback_next",
          message: t("aiBlockMissingNext", { key: cfg.fallback_next }),
        });
      }
      if (cfg.identify_receipt && cfg.receipt_next && !knownKeys.has(cfg.receipt_next)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "receipt_next",
          message: t("aiBlockMissingNext", { key: cfg.receipt_next }),
        });
      }
      const condiciones = cfg.conditions ?? [];
      if (condiciones.length > 10) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "conditions",
          message: t("aiBlockMaxConditions"),
        });
      }
      const ids = new Set<string>();
      for (const c of condiciones) {
        if (!c.id || ids.has(c.id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "conditions",
            message: t("aiBlockDuplicateCondition"),
          });
        }
        ids.add(c.id ?? "");
        if (!c.next_node_key || !knownKeys.has(c.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "conditions",
            message: t("aiBlockMissingNext", { key: c.next_node_key ?? "" }),
          });
        }
      }
      const ventana = Number(cfg.context_window ?? 10);
      if (!Number.isFinite(ventana) || ventana < 5 || ventana > 20) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "context_window",
          message: t("aiBlockContextRange"),
        });
      }
      break;
    }

    case "manipulator": {
      const cfg = node.config as { key?: string; next_node_key?: string };
      if (!cfg.key?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "key", message: t("manipulatorNeedsKey") });
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("manipulatorMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }
    case "distributor": {
      const cfg = node.config as { outputs?: Array<{ next_node_key?: string }> };
      const outputs = cfg.outputs ?? [];
      if (outputs.length === 0) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "outputs", message: t("distributorNeedsOutputs") });
      }
      for (const o of outputs) {
        if (!o.next_node_key || !knownKeys.has(o.next_node_key)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "outputs", message: t("distributorMissingNext", { key: o.next_node_key ?? "" }) });
        }
      }
      break;
    }
    case "notification": {
      const cfg = node.config as { phone?: string; message?: string; next_node_key?: string };
      if (!cfg.phone?.replace(/D/g, "")) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "phone", message: t("notificationNeedsPhone") });
      }
      if (!cfg.message?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "message", message: t("notificationNeedsMessage") });
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("notificationMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }
    case "sale_approved": {
      const cfg = node.config as { pipeline_id?: string; stage_id?: string; amount_var?: string; next_node_key?: string };
      if (!cfg.pipeline_id || !cfg.stage_id) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "stage_id", message: t("saleNeedsStage") });
      }
      if (!cfg.amount_var?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "amount_var", message: t("saleNeedsAmount") });
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("saleMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }
    case "carousel": {
      const cfg = node.config as { expires_days?: number; cards?: Array<{ buttons?: Array<{ type?: string; next_node_key?: string }> }>; timeout_next?: string };
      const cards = cfg.cards ?? [];
      if (cards.length === 0) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "cards", message: t("carouselNeedsCards") });
      }
      if (cards.length > 10) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "cards", message: t("carouselMaxCards") });
      }
      const dias = Number(cfg.expires_days ?? 1);
      if (!Number.isFinite(dias) || dias < 1 || dias > 31) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "expires_days", message: t("carouselDaysRange") });
      }
      for (const card of cards) {
        const buttons = card.buttons ?? [];
        if (buttons.length > 3) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "cards", message: t("carouselMaxButtons") });
        }
        for (const b of buttons) {
          if (b.type !== "url" && (!b.next_node_key || !knownKeys.has(b.next_node_key))) {
            issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "cards", message: t("carouselMissingNext", { key: b.next_node_key ?? "" }) });
          }
        }
      }
      if (cfg.timeout_next && !knownKeys.has(cfg.timeout_next)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "timeout_next", message: t("carouselMissingNext", { key: cfg.timeout_next }) });
      }
      break;
    }
    case "department": {
      const cfg = node.config as { department_id?: string; next_node_key?: string };
      if (!cfg.department_id) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "department_id", message: t("departmentNeedsDepartment") });
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("blockMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }
    case "http_request": {
      const cfg = node.config as {
        method?: string;
        url?: string;
        body_type?: string;
        body?: string;
        error_next?: string;
        next_node_key?: string;
      };
      if (!cfg.url?.trim() || !/^https?:\/\//i.test(cfg.url.trim())) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "url", message: t("httpNeedsUrl") });
      }
      if (!cfg.method || !["GET", "POST", "PUT", "DELETE"].includes(cfg.method)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "method", message: t("httpNeedsMethod") });
      }
      if (cfg.body_type === "json" && cfg.body?.trim()) {
        try {
          JSON.parse(cfg.body);
        } catch {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "body", message: t("httpBadJson") });
        }
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("blockMissingNext", { key: cfg.next_node_key }) });
      }
      if (cfg.error_next && !knownKeys.has(cfg.error_next)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "error_next", message: t("blockMissingNext", { key: cfg.error_next }) });
      }
      break;
    }
    case "payment_gateway": {
      const cfg = node.config as {
        provider?: string;
        currency?: string;
        amount_mode?: string;
        amount?: number;
        amount_var?: string;
        checkout_url?: string;
        wait_minutes?: number;
        approved_next?: string;
        rejected_next?: string;
        timeout_next?: string;
      };
      if (!cfg.provider || !["hotmart", "whop", "mercadopago", "stripe", "spei"].includes(cfg.provider)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "provider", message: t("gatewayNeedsProvider") });
      }
      if (!cfg.currency || !["MXN", "USD"].includes(cfg.currency)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "currency", message: t("gatewayNeedsCurrency") });
      }
      if (cfg.amount_mode === "variable") {
        if (!cfg.amount_var?.trim()) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "amount_var", message: t("gatewayNeedsAmountVar") });
        }
      } else if (!(Number(cfg.amount) > 0)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "amount", message: t("gatewayNeedsAmount") });
      }
      if (cfg.provider !== "spei" && !cfg.checkout_url?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "checkout_url", message: t("gatewayNeedsCheckout") });
      }
      const wait = Number(cfg.wait_minutes);
      if (!Number.isFinite(wait) || wait < 5 || wait > PAYMENT_GATEWAY_MAX_MINUTOS) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "wait_minutes", message: t("gatewayWaitRange") });
      }
      if (!cfg.approved_next) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "approved_next", message: t("gatewayNeedsApprovedNext") });
      } else if (!knownKeys.has(cfg.approved_next)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "approved_next", message: t("blockMissingNext", { key: cfg.approved_next }) });
      }
      for (const [campo, valor] of [["rejected_next", cfg.rejected_next], ["timeout_next", cfg.timeout_next]] as const) {
        if (valor && !knownKeys.has(valor)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: campo, message: t("blockMissingNext", { key: valor }) });
        }
      }
      break;
    }
    case "ai_media": {
      const cfg = node.config as {
        kind?: "audio" | "image";
        audio?: { text?: string; voice?: string };
        image?: { prompt?: string };
        next_node_key?: string;
      };
      if (cfg.kind === "audio") {
        if (!cfg.audio?.text?.trim()) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "audio.text", message: t("aiMediaNeedsText") });
        }
        if (!cfg.audio?.voice?.trim()) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "audio.voice", message: t("aiMediaNeedsVoice") });
        }
      } else if (cfg.kind === "image") {
        if (!cfg.image?.prompt?.trim()) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "image.prompt", message: t("aiMediaNeedsPrompt") });
        }
      } else {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "kind", message: t("aiMediaNeedsKind") });
      }
      if (cfg.next_node_key && !knownKeys.has(cfg.next_node_key)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "next_node_key", message: t("blockMissingNext", { key: cfg.next_node_key }) });
      }
      break;
    }
    case "official_call": {
      const cfg = node.config as {
        mode?: string;
        body_text?: string;
        template_name?: string;
        wait_days?: number;
        granted_next?: string;
        denied_next?: string;
        timeout_next?: string;
      };
      if (!cfg.body_text?.trim() && !cfg.template_name?.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "body_text", message: t("officialCallNeedsText") });
      }
      if (cfg.mode && cfg.mode !== "permission" && cfg.mode !== "call") {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "mode", message: t("officialCallNeedsMode") });
      }
      const dias = Number(cfg.wait_days ?? 7);
      if (!Number.isFinite(dias) || dias < 1 || dias > 7) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "wait_days", message: t("officialCallWaitRange") });
      }
      if (!cfg.granted_next) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "granted_next", message: t("officialCallNeedsGranted") });
      } else if (!knownKeys.has(cfg.granted_next)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "granted_next", message: t("blockMissingNext", { key: cfg.granted_next }) });
      }
      for (const [campo, valor] of [["denied_next", cfg.denied_next], ["timeout_next", cfg.timeout_next]] as const) {
        if (valor && !knownKeys.has(valor)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: campo, message: t("blockMissingNext", { key: valor }) });
        }
      }
      break;
    }
    case "handoff":
    case "end":
      // Terminal nodes have no outgoing edges; nothing to validate
      // beyond their existence.
      break;

    default:
      issues.push({
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        message: t("unknownNodeType", { type: node.node_type }),
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[],
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "meta_capi":
    case "send_template":
    case "move_kanban":
    case "set_tag":
    case "department":
    case "ai_media": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "wait": {
      const cfg = node.config as {
        next_node_key?: string;
        fuera_ventana_next?: string;
      };
      return [cfg.next_node_key, cfg.fuera_ventana_next].filter(
        (k): k is string => !!k,
      );
    }
    case "http_request": {
      const cfg = node.config as {
        next_node_key?: string;
        error_next?: string;
      };
      return [cfg.next_node_key, cfg.error_next].filter(
        (k): k is string => !!k,
      );
    }
    case "payment_gateway": {
      const cfg = node.config as {
        approved_next?: string;
        rejected_next?: string;
        timeout_next?: string;
      };
      return [cfg.approved_next, cfg.rejected_next, cfg.timeout_next].filter(
        (k): k is string => !!k,
      );
    }
    case "official_call": {
      const cfg = node.config as {
        granted_next?: string;
        denied_next?: string;
        timeout_next?: string;
      };
      return [cfg.granted_next, cfg.denied_next, cfg.timeout_next].filter(
        (k): k is string => !!k,
      );
    }
    case "send_payment": {
      const cfg = node.config as { aprobado_next?: string; rechazado_next?: string };
      return [cfg.aprobado_next, cfg.rechazado_next].filter((k): k is string => !!k);
    }
    case "save_reply": {
      const cfg = node.config as {
        contesto_next?: string;
        no_contesto_next?: string;
      };
      return [cfg.contesto_next, cfg.no_contesto_next].filter(
        (k): k is string => !!k,
      );
    }
    case "condition": {
      const cfg = node.config as {
        true_next?: string;
        false_next?: string;
      };
      const out: string[] = [];
      if (cfg.true_next) out.push(cfg.true_next);
      if (cfg.false_next) out.push(cfg.false_next);
      return out;
    }
    case "send_buttons": {
      const cfg = node.config as {
        buttons?: Array<{ next_node_key?: string }>;
      };
      return (cfg.buttons ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case "send_list": {
      const cfg = node.config as {
        sections?: Array<{ rows?: Array<{ next_node_key?: string }> }>;
      };
      const out: string[] = [];
      for (const s of cfg.sections ?? []) {
        for (const r of s.rows ?? []) {
          if (r.next_node_key) out.push(r.next_node_key);
        }
      }
      return out;
    }
    case "manipulator":
    case "notification":
    case "sale_approved": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "distributor": {
      const cfg = node.config as { outputs?: Array<{ next_node_key?: string }> };
      return (cfg.outputs ?? []).map((o) => o.next_node_key).filter((k): k is string => !!k);
    }
    case "carousel": {
      const cfg = node.config as { cards?: Array<{ buttons?: Array<{ type?: string; next_node_key?: string }> }>; timeout_next?: string };
      const out: string[] = [];
      for (const card of cfg.cards ?? []) {
        for (const b of card.buttons ?? []) {
          if (b.type !== "url" && b.next_node_key) out.push(b.next_node_key);
        }
      }
      if (cfg.timeout_next) out.push(cfg.timeout_next);
      return out;
    }
    case "connect_flow":
      return [];
    case "ai_block": {
      const cfg = node.config as {
        conditions?: Array<{ next_node_key?: string }>;
        receipt_next?: string;
        fallback_next?: string;
        identify_receipt?: boolean;
      };
      const out = (cfg.conditions ?? [])
        .map((c) => c.next_node_key)
        .filter((k): k is string => !!k);
      if (cfg.identify_receipt && cfg.receipt_next) out.push(cfg.receipt_next);
      if (cfg.fallback_next) out.push(cfg.fallback_next);
      return out;
    }
    case "handoff":
    case "end":
    default:
      return [];
  }
}
