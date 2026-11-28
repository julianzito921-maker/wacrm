/**
 * Derive canvas edges from the flow's node list.
 *
 * Edges live INSIDE each node's `config` JSONB (each button row /
 * list row / condition branch carries its own `next_node_key`). The
 * canvas needs them as a separate `{ source, target, label,
 * sourceHandle }` list to render arrows, and the labels need to be
 * meaningful — a `send_buttons` node with three buttons isn't useful
 * on the canvas if the three outgoing arrows are unlabeled.
 *
 * Why this lives in lib/flows (not next to flow-canvas.tsx): the
 * derivation is pure data manipulation with no React-Flow types in
 * it, which makes it (a) trivially unit-testable and (b) reusable by
 * the editable canvas (PR 2) without dragging in client-only deps.
 *
 * `sourceHandle` ids are stable strings the canvas wires up to its
 * per-node renderer's outgoing connection points. They match the
 * scheme PR 2's drag-to-connect handler will read:
 *   - `next`            for single-outgoing nodes
 *   - `button:<reply_id>` for send_buttons rows
 *   - `row:<reply_id>`    for send_list rows
 *   - `true` / `false`    for condition branches
 */

import type { BuilderNode } from "@/components/flows/shared";
import { aplicarConexionAiBlock } from "./bloques-avanzados";

export interface CanvasEdge {
  /** Stable per-edge id — required by React-Flow. */
  id: string;
  /** node_key of the source node. */
  source: string;
  /** node_key of the target node. */
  target: string;
  /** Identifies which outgoing slot on the source node this edge belongs to. */
  sourceHandle: string;
  /** Human-readable label rendered on the canvas (e.g. "Yes button"). */
  label?: string;
}

export function deriveCanvasEdges(nodes: BuilderNode[]): CanvasEdge[] {
  const knownKeys = new Set(nodes.map((n) => n.node_key));
  const edges: CanvasEdge[] = [];

  for (const node of nodes) {
    const cfg = node.config;
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
      case "notification":
      case "sale_approved":
      case "manipulator":
      case "ai_media": {
        const next = (cfg as { next_node_key?: string }).next_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
          });
        }
        break;
      }

      case "wait": {
        const c = cfg as { next_node_key?: string; fuera_ventana_next?: string };
        if (c.next_node_key && knownKeys.has(c.next_node_key)) {
          edges.push({
            id: `${node.node_key}--next--${c.next_node_key}`,
            source: node.node_key,
            target: c.next_node_key,
            sourceHandle: "next",
          });
        }
        if (c.fuera_ventana_next && knownKeys.has(c.fuera_ventana_next)) {
          edges.push({
            id: `${node.node_key}--fuera_ventana--${c.fuera_ventana_next}`,
            source: node.node_key,
            target: c.fuera_ventana_next,
            sourceHandle: "fuera_ventana",
            label: "fuera de ventana",
          });
        }
        break;
      }

      case "http_request": {
        const c = cfg as { next_node_key?: string; error_next?: string };
        if (c.next_node_key && knownKeys.has(c.next_node_key)) {
          edges.push({
            id: `${node.node_key}--next--${c.next_node_key}`,
            source: node.node_key,
            target: c.next_node_key,
            sourceHandle: "next",
          });
        }
        if (c.error_next && knownKeys.has(c.error_next)) {
          edges.push({
            id: `${node.node_key}--error--${c.error_next}`,
            source: node.node_key,
            target: c.error_next,
            sourceHandle: "error",
            label: "si falla",
          });
        }
        break;
      }

      case "payment_gateway": {
        const c = cfg as {
          approved_next?: string;
          rejected_next?: string;
          timeout_next?: string;
        };
        const slots: Array<[string, string | undefined, string]> = [
          ["approved", c.approved_next, "pago aprobado"],
          ["rejected", c.rejected_next, "pago rechazado"],
          ["timeout", c.timeout_next, "sin pago"],
        ];
        for (const [handle, target, label] of slots) {
          if (!target || !knownKeys.has(target)) continue;
          edges.push({
            id: `${node.node_key}--${handle}--${target}`,
            source: node.node_key,
            target,
            sourceHandle: handle,
            label,
          });
        }
        break;
      }

      case "official_call": {
        const c = cfg as {
          granted_next?: string;
          denied_next?: string;
          timeout_next?: string;
        };
        const slots: Array<[string, string | undefined, string]> = [
          ["granted", c.granted_next, "permiso concedido"],
          ["denied", c.denied_next, "permiso denegado"],
          ["timeout", c.timeout_next, "sin respuesta"],
        ];
        for (const [handle, target, label] of slots) {
          if (!target || !knownKeys.has(target)) continue;
          edges.push({
            id: `${node.node_key}--${handle}--${target}`,
            source: node.node_key,
            target,
            sourceHandle: handle,
            label,
          });
        }
        break;
      }

      case "send_payment": {
        const aprobado = (cfg as { aprobado_next?: string }).aprobado_next;
        const rechazado = (cfg as { rechazado_next?: string }).rechazado_next;
        if (aprobado && knownKeys.has(aprobado)) {
          edges.push({
            id: `${node.node_key}--aprobado--${aprobado}`,
            source: node.node_key,
            target: aprobado,
            sourceHandle: "aprobado",
            label: "aprobado",
          });
        }
        if (rechazado && knownKeys.has(rechazado)) {
          edges.push({
            id: `${node.node_key}--rechazado--${rechazado}`,
            source: node.node_key,
            target: rechazado,
            sourceHandle: "rechazado",
            label: "rechazado / timeout",
          });
        }
        break;
      }

      case "save_reply": {
        const srCfg = cfg as {
          contesto_next?: string;
          no_contesto_next?: string;
          esperar_indefinido?: boolean;
        };
        const contesto = srCfg.contesto_next;
        // «Esperar indefinidamente» no tiene segunda salida.
        const noContesto = srCfg.esperar_indefinido ? undefined : srCfg.no_contesto_next;
        if (contesto && knownKeys.has(contesto)) {
          edges.push({
            id: `${node.node_key}--contesto--${contesto}`,
            source: node.node_key,
            target: contesto,
            sourceHandle: "contesto",
            label: "si contesta",
          });
        }
        if (noContesto && knownKeys.has(noContesto)) {
          edges.push({
            id: `${node.node_key}--no_contesto--${noContesto}`,
            source: node.node_key,
            target: noContesto,
            sourceHandle: "no_contesto",
            label: "si no contesta",
          });
        }
        break;
      }

      case "condition": {
        const trueNext = (cfg as { true_next?: string }).true_next;
        const falseNext = (cfg as { false_next?: string }).false_next;
        if (trueNext && knownKeys.has(trueNext)) {
          edges.push({
            id: `${node.node_key}--true--${trueNext}`,
            source: node.node_key,
            target: trueNext,
            sourceHandle: "true",
            label: "true",
          });
        }
        if (falseNext && knownKeys.has(falseNext)) {
          edges.push({
            id: `${node.node_key}--false--${falseNext}`,
            source: node.node_key,
            target: falseNext,
            sourceHandle: "false",
            label: "false",
          });
        }
        break;
      }

      case "send_buttons": {
        const buttons = Array.isArray(
          (cfg as { buttons?: unknown }).buttons,
        )
          ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
          : [];
        for (const btn of buttons) {
          const replyId =
            typeof btn.reply_id === "string" ? btn.reply_id : null;
          const next =
            typeof btn.next_node_key === "string" ? btn.next_node_key : null;
          const title = typeof btn.title === "string" ? btn.title : null;
          if (!replyId || !next || !knownKeys.has(next)) continue;
          edges.push({
            id: `${node.node_key}--button:${replyId}--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: `button:${replyId}`,
            label: title ?? replyId,
          });
        }
        break;
      }

      case "send_list": {
        const sections = Array.isArray(
          (cfg as { sections?: unknown }).sections,
        )
          ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
          : [];
        for (const section of sections) {
          const rows = Array.isArray(section.rows)
            ? (section.rows as Array<Record<string, unknown>>)
            : [];
          for (const row of rows) {
            const replyId =
              typeof row.reply_id === "string" ? row.reply_id : null;
            const next =
              typeof row.next_node_key === "string" ? row.next_node_key : null;
            const title = typeof row.title === "string" ? row.title : null;
            if (!replyId || !next || !knownKeys.has(next)) continue;
            edges.push({
              id: `${node.node_key}--row:${replyId}--${next}`,
              source: node.node_key,
              target: next,
              sourceHandle: `row:${replyId}`,
              label: title ?? replyId,
            });
          }
        }
        break;
      }

      case "ai_block": {
        const c = cfg as {
          conditions?: Array<{ id?: string; label?: string; next_node_key?: string }>;
          identify_receipt?: boolean;
          receipt_next?: string;
          fallback_next?: string;
        };
        const salidas: Array<[string, string | undefined, string | undefined]> = (c.conditions ?? [])
          .filter((x) => typeof x.id === "string" && x.id)
          .map((x) => [`cond:${x.id}`, x.next_node_key, x.label || x.id]);
        if (c.identify_receipt) salidas.push(["receipt", c.receipt_next, "comprobante"]);
        salidas.push(["fallback", c.fallback_next, undefined]);
        for (const [handle, target, label] of salidas) {
          if (!target || !knownKeys.has(target)) continue;
          edges.push({
            id: `${node.node_key}--${handle}--${target}`,
            source: node.node_key,
            target,
            sourceHandle: handle,
            ...(label ? { label } : {}),
          });
        }
        break;
      }

      case "distributor": {
        const outs = (cfg as { outputs?: Array<{ id?: string; label?: string; next_node_key?: string }> }).outputs ?? [];
        for (const o of outs) {
          if (!o.id || !o.next_node_key || !knownKeys.has(o.next_node_key)) continue;
          edges.push({
            id: `${node.node_key}--out:${o.id}--${o.next_node_key}`,
            source: node.node_key,
            target: o.next_node_key,
            sourceHandle: `out:${o.id}`,
            label: o.label || o.id,
          });
        }
        break;
      }

      case "carousel": {
        const c = cfg as {
          cards?: Array<{ id?: string; buttons?: Array<{ id?: string; label?: string; type?: string; next_node_key?: string }> }>;
          timeout_next?: string;
        };
        for (const card of c.cards ?? []) {
          for (const b of card.buttons ?? []) {
            if (b.type === "url" || !card.id || !b.id) continue;
            if (!b.next_node_key || !knownKeys.has(b.next_node_key)) continue;
            edges.push({
              id: `${node.node_key}--car_${card.id}_${b.id}--${b.next_node_key}`,
              source: node.node_key,
              target: b.next_node_key,
              sourceHandle: `car_${card.id}_${b.id}`,
              label: b.label || b.id,
            });
          }
        }
        if (c.timeout_next && knownKeys.has(c.timeout_next)) {
          edges.push({
            id: `${node.node_key}--timeout--${c.timeout_next}`,
            source: node.node_key,
            target: c.timeout_next,
            sourceHandle: "timeout",
            label: "sin respuesta",
          });
        }
        break;
      }

      case "handoff":
      case "end":
        // Terminal nodes — no outgoing edges.
        break;
    }
  }

  return edges;
}

// ============================================================
// Inverse operations — used by the canvas's drag-to-connect and
// delete-with-cleanup handlers (PR 2b). Kept in lib/flows so the
// canvas component stays free of edge-bookkeeping logic.
// ============================================================

/**
 * Outgoing-slot list for a node — used by the canvas to render one
 * source-side Handle per slot, labelled with the slot's user-facing
 * name. Order follows the order the slots appear in the node's
 * config so visual layout matches the form layout.
 *
 * Terminal nodes (handoff / end) return an empty list — they have
 * no outgoing edges and no source handles.
 */
export interface OutgoingSlot {
  /** Stable id matching the `sourceHandle` scheme used in
   *  CanvasEdge. */
  id: string;
  /** Visible label rendered next to the handle. */
  label: string;
}

export function outgoingSlots(node: BuilderNode): OutgoingSlot[] {
  const cfg = node.config;
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
    case "notification":
    case "sale_approved":
    case "manipulator":
    case "ai_media":
      return [{ id: "next", label: "Next" }];

    case "wait":
      return [
        { id: "next", label: "Next" },
        { id: "fuera_ventana", label: "Fuera de ventana" },
      ];

    case "http_request":
      return [
        { id: "next", label: "Next" },
        { id: "error", label: "Si falla" },
      ];

    case "payment_gateway":
      return [
        { id: "approved", label: "Pago aprobado" },
        { id: "rejected", label: "Pago rechazado" },
        { id: "timeout", label: "Sin pago" },
      ];

    case "official_call":
      return [
        { id: "granted", label: "Permiso concedido" },
        { id: "denied", label: "Permiso denegado" },
        { id: "timeout", label: "Sin respuesta" },
      ];

    case "send_payment":
      return [
        { id: "aprobado", label: "Aprobado" },
        { id: "rechazado", label: "Rechazado / Timeout" },
      ];

    case "save_reply":
      return [
        { id: "contesto", label: "Si contesta" },
        // «Esperar indefinidamente» no tiene salida por timeout.
        ...((cfg as { esperar_indefinido?: boolean }).esperar_indefinido
          ? []
          : [{ id: "no_contesto", label: "Si no contesta" }]),
      ];

    case "condition":
      return [
        { id: "true", label: "true" },
        { id: "false", label: "false" },
      ];

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
        : [];
      return buttons
        .filter((b) => typeof b.reply_id === "string" && b.reply_id)
        .map((b) => {
          const replyId = b.reply_id as string;
          const title = typeof b.title === "string" ? b.title : null;
          return {
            id: `button:${replyId}`,
            label: title ?? replyId,
          };
        });
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
        : [];
      const slots: OutgoingSlot[] = [];
      for (const section of sections) {
        const rows = Array.isArray(section.rows)
          ? (section.rows as Array<Record<string, unknown>>)
          : [];
        for (const row of rows) {
          const replyId =
            typeof row.reply_id === "string" ? row.reply_id : null;
          if (!replyId) continue;
          const title = typeof row.title === "string" ? row.title : null;
          slots.push({
            id: `row:${replyId}`,
            label: title ?? replyId,
          });
        }
      }
      return slots;
    }

    case "connect_flow":
      return [];

    case "ai_block": {
      const c = cfg as {
        conditions?: Array<{ id?: string; label?: string }>;
        identify_receipt?: boolean;
      };
      const slots: OutgoingSlot[] = (c.conditions ?? [])
        .filter((x) => typeof x.id === "string" && x.id)
        .map((x) => ({ id: `cond:${x.id}`, label: x.label || x.id! }));
      if (c.identify_receipt) {
        slots.push({ id: "receipt", label: "Comprobante válido" });
      }
      slots.push({ id: "fallback", label: "Sin coincidencia" });
      return slots;
    }

    case "distributor": {
      const outs = (cfg as { outputs?: Array<{ id?: string; label?: string }> }).outputs ?? [];
      return outs
        .filter((o) => typeof o.id === "string" && o.id)
        .map((o, i) => ({ id: `out:${o.id}`, label: o.label || `Camino ${i + 1}` }));
    }

    case "carousel": {
      const c = cfg as {
        cards?: Array<{ id?: string; buttons?: Array<{ id?: string; label?: string; type?: string }> }>;
      };
      const slots: OutgoingSlot[] = [];
      for (const card of c.cards ?? []) {
        for (const b of card.buttons ?? []) {
          if (b.type === "url" || !card.id || !b.id) continue;
          slots.push({ id: `car_${card.id}_${b.id}`, label: b.label || b.id });
        }
      }
      slots.push({ id: "timeout", label: "Sin respuesta" });
      return slots;
    }

    case "handoff":
    case "end":
      return [];
    default:
      return [];
  }
}

/**
 * Compute the config patch to apply when the user drags an edge from
 * `sourceHandle` on a node to `targetKey`. Returns `null` when the
 * handle isn't recognised on the node type (defensive — React-Flow
 * would have to misroute for this to fire).
 *
 * For `send_buttons` and `send_list`, only the button/row with the
 * matching reply_id is patched; the rest of the array passes through
 * unchanged.
 */
export function applyEdgeConnection(
  node: BuilderNode,
  sourceHandle: string,
  targetKey: string,
): Record<string, unknown> | null {
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
    case "notification":
    case "sale_approved":
    case "manipulator":
    case "ai_media":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      return null;

    case "wait":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      if (sourceHandle === "fuera_ventana") return { fuera_ventana_next: targetKey };
      return null;

    case "http_request":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      if (sourceHandle === "error") return { error_next: targetKey };
      return null;

    case "payment_gateway":
      if (sourceHandle === "approved") return { approved_next: targetKey };
      if (sourceHandle === "rejected") return { rejected_next: targetKey };
      if (sourceHandle === "timeout") return { timeout_next: targetKey };
      return null;

    case "official_call":
      if (sourceHandle === "granted") return { granted_next: targetKey };
      if (sourceHandle === "denied") return { denied_next: targetKey };
      if (sourceHandle === "timeout") return { timeout_next: targetKey };
      return null;

    case "send_payment":
      if (sourceHandle === "aprobado") return { aprobado_next: targetKey };
      if (sourceHandle === "rechazado") return { rechazado_next: targetKey };
      return null;

    case "save_reply":
      if (sourceHandle === "contesto") return { contesto_next: targetKey };
      if (sourceHandle === "no_contesto") return { no_contesto_next: targetKey };
      return null;

    case "condition":
      if (sourceHandle === "true") return { true_next: targetKey };
      if (sourceHandle === "false") return { false_next: targetKey };
      return null;

    case "send_buttons": {
      if (!sourceHandle.startsWith("button:")) return null;
      const replyId = sourceHandle.slice("button:".length);
      const buttons = Array.isArray(
        (node.config as { buttons?: unknown }).buttons,
      )
        ? (node.config as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      // No matching button → no-op (caller should have surfaced a
      // missing slot before letting the user drag).
      if (!buttons.some((b) => b.reply_id === replyId)) return null;
      return {
        buttons: buttons.map((b) =>
          b.reply_id === replyId ? { ...b, next_node_key: targetKey } : b,
        ),
      };
    }

    case "send_list": {
      if (!sourceHandle.startsWith("row:")) return null;
      const replyId = sourceHandle.slice("row:".length);
      const sections = Array.isArray(
        (node.config as { sections?: unknown }).sections,
      )
        ? (node.config as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let matched = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.reply_id === replyId) {
              matched = true;
              return { ...r, next_node_key: targetKey };
            }
            return r;
          }),
        };
      });
      return matched ? { sections: next } : null;
    }

    case "distributor": {
      if (!sourceHandle.startsWith("out:")) return null;
      const id = sourceHandle.slice(4);
      const c = node.config as { outputs?: Array<{ id?: string; next_node_key?: string }> };
      const outputs = c.outputs ?? [];
      if (!outputs.some((o) => o.id === id)) return null;
      return { outputs: outputs.map((o) => (o.id === id ? { ...o, next_node_key: targetKey } : o)) };
    }

    case "carousel": {
      const c = node.config as {
        cards?: Array<{ id?: string; buttons?: Array<{ id?: string; next_node_key?: string; type?: string }> }>;
        timeout_next?: string;
      };
      if (sourceHandle === "timeout") return { timeout_next: targetKey };
      if (!sourceHandle.startsWith("car_")) return null;
      const resto = sourceHandle.slice(4);
      const sep = resto.lastIndexOf("_");
      if (sep < 0) return null;
      const cardId = resto.slice(0, sep);
      const buttonId = resto.slice(sep + 1);
      const cards = c.cards ?? [];
      if (!cards.some((card) => card.id === cardId && (card.buttons ?? []).some((b) => b.id === buttonId))) {
        return null;
      }
      return {
        cards: cards.map((card) =>
          card.id === cardId
            ? {
                ...card,
                buttons: (card.buttons ?? []).map((b) =>
                  b.id === buttonId ? { ...b, next_node_key: targetKey } : b,
                ),
              }
            : card,
        ),
      };
    }

    case "connect_flow":
      return null;

    case "ai_block":
      return aplicarConexionAiBlock(node.config as Record<string, unknown>, sourceHandle, targetKey);

    case "handoff":
    case "end":
      return null;
    default:
      return null;
  }
}

/**
 * Walk every node and clear any `next_node_key` / `true_next` /
 * `false_next` / `button.next_node_key` / `row.next_node_key`
 * reference to `deletedKey`. Cleared refs become the empty string —
 * the same "no target picked" sentinel the builder forms use.
 *
 * Returns a new array; original nodes are left untouched. Nodes
 * without any matching reference pass through by identity to avoid
 * needless re-renders downstream.
 */
export function unlinkNodeReferences(
  nodes: BuilderNode[],
  deletedKey: string,
): BuilderNode[] {
  return nodes.map((n) => {
    const patched = patchedConfigWithoutKey(n, deletedKey);
    return patched ? { ...n, config: patched } : n;
  });
}

function patchedConfigWithoutKey(
  node: BuilderNode,
  deletedKey: string,
): Record<string, unknown> | null {
  const cfg = node.config;
  switch (node.node_type) {
    case "send_payment": {
      const c = cfg as { aprobado_next?: string; rechazado_next?: string };
      const patch: Record<string, unknown> = {};
      if (c.aprobado_next === deletedKey) patch.aprobado_next = "";
      if (c.rechazado_next === deletedKey) patch.rechazado_next = "";
      return Object.keys(patch).length ? patch : null;
    }

    case "save_reply": {
      const c = cfg as { contesto_next?: string; no_contesto_next?: string };
      const patch: Record<string, unknown> = {};
      if (c.contesto_next === deletedKey) patch.contesto_next = "";
      if (c.no_contesto_next === deletedKey) patch.no_contesto_next = "";
      return Object.keys(patch).length ? patch : null;
    }

    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "meta_capi":
    case "send_template":
    case "move_kanban":
    case "set_tag":
    case "department":
    case "notification":
    case "sale_approved":
    case "manipulator":
    case "ai_media": {
      const next = (cfg as { next_node_key?: string }).next_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, next_node_key: "" };
    }

    case "wait": {
      const c = cfg as { next_node_key?: string; fuera_ventana_next?: string };
      const nextMatch = c.next_node_key === deletedKey;
      const ventanaMatch = c.fuera_ventana_next === deletedKey;
      if (!nextMatch && !ventanaMatch) return null;
      return {
        ...cfg,
        ...(nextMatch ? { next_node_key: "" } : {}),
        ...(ventanaMatch ? { fuera_ventana_next: "" } : {}),
      };
    }

    case "http_request": {
      const c = cfg as { next_node_key?: string; error_next?: string };
      const nextMatch = c.next_node_key === deletedKey;
      const errorMatch = c.error_next === deletedKey;
      if (!nextMatch && !errorMatch) return null;
      return {
        ...cfg,
        ...(nextMatch ? { next_node_key: "" } : {}),
        ...(errorMatch ? { error_next: "" } : {}),
      };
    }

    case "payment_gateway": {
      const c = cfg as {
        approved_next?: string;
        rejected_next?: string;
        timeout_next?: string;
      };
      const patch: Record<string, unknown> = {};
      if (c.approved_next === deletedKey) patch.approved_next = "";
      if (c.rejected_next === deletedKey) patch.rejected_next = "";
      if (c.timeout_next === deletedKey) patch.timeout_next = "";
      return Object.keys(patch).length ? { ...cfg, ...patch } : null;
    }

    case "official_call": {
      const c = cfg as {
        granted_next?: string;
        denied_next?: string;
        timeout_next?: string;
      };
      const patch: Record<string, unknown> = {};
      if (c.granted_next === deletedKey) patch.granted_next = "";
      if (c.denied_next === deletedKey) patch.denied_next = "";
      if (c.timeout_next === deletedKey) patch.timeout_next = "";
      return Object.keys(patch).length ? { ...cfg, ...patch } : null;
    }

    case "condition": {
      const c = cfg as { true_next?: string; false_next?: string };
      const trueMatch = c.true_next === deletedKey;
      const falseMatch = c.false_next === deletedKey;
      if (!trueMatch && !falseMatch) return null;
      return {
        ...cfg,
        ...(trueMatch ? { true_next: "" } : {}),
        ...(falseMatch ? { false_next: "" } : {}),
      };
    }

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? (cfg as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      if (!buttons.some((b) => b.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        buttons: buttons.map((b) =>
          b.next_node_key === deletedKey ? { ...b, next_node_key: "" } : b,
        ),
      };
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? (cfg as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let dirty = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.next_node_key === deletedKey) {
              dirty = true;
              return { ...r, next_node_key: "" };
            }
            return r;
          }),
        };
      });
      return dirty ? { ...cfg, sections: next } : null;
    }

    case "connect_flow":
      return null;

    case "ai_block":
    case "distributor":
    case "carousel":
      return quitarReferencias(cfg, deletedKey);

    case "handoff":
    case "end":
      return null;
    default:
      return null;
  }
}



/**
 * Vacía cualquier `*_next` / `next_node_key` que apunte a `deletedKey`,
 * también dentro de listas (condiciones de IA, salidas del distribuidor,
 * botones del carrusel). Devuelve null si no había nada que cambiar.
 */
function quitarReferencias(
  cfg: Record<string, unknown>,
  deletedKey: string,
): Record<string, unknown> | null {
  let cambio = false;
  const limpiar = (valor: unknown, clave?: string): unknown => {
    if (Array.isArray(valor)) return valor.map((v) => limpiar(v));
    if (valor && typeof valor === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) out[k] = limpiar(v, k);
      return out;
    }
    if (clave && (clave === "next_node_key" || clave.endsWith("_next")) && valor === deletedKey) {
      cambio = true;
      return "";
    }
    return valor;
  };
  const limpio = limpiar(cfg) as Record<string, unknown>;
  return cambio ? limpio : null;
}
