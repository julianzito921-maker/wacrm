"use client";

/**
 * Single source of truth for the flow editor's state.
 *
 * Both views (list and canvas) read and mutate the same `BuilderState`
 * via `useFlowEditor()`. The provider mounts once inside
 * `FlowEditorShell`, so toggling views never resets unsaved edits.
 *
 * What lives here:
 *   - `BuilderState` shape (header fields, trigger config, nodes).
 *   - Dirty / saving / activating flags so the header save button
 *     and the beforeunload guard share the same source.
 *   - All mutations: name / description / trigger / fallback,
 *     addNode / updateNode / updateNodeConfig / updateNodePosition /
 *     removeNode, setEntryNodeId.
 *   - Side effects: save (PUT), setStatus (POST /activate),
 *     deleteFlow (DELETE then router.push).
 *   - Validation issues + the canActivate boolean.
 *
 * What does NOT live here:
 *   - List-view UI state (expanded card set, scroll refs,
 *     flash-on-jump) — those are list-only and stay in
 *     `flow-builder.tsx`.
 *   - Canvas-view UI state (selected node id, side-sheet open) —
 *     those are canvas-only and stay in `flow-canvas.tsx`.
 *
 * `removeNode` deletes a node and repairs the graph around it: when
 * the node sat in a straight line (one inbound edge, one outbound) the
 * predecessor is re-pointed at the successor, so cutting a step out of
 * a chain doesn't cascade into «missing next» / unreachable errors.
 * Otherwise the inbound references are cleared (the empty-string
 * sentinel the forms already use for «no target picked»).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  validateFlowForActivation,
  type ValidationIssue,
} from "@/lib/flows/validate";
import { useTranslations } from "next-intl";
import { getT } from "@/lib/i18n/translate";
import {
  applyEdgeConnection,
  deriveCanvasEdges,
  unlinkNodeReferences,
} from "@/lib/flows/edges";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";
import { NODE_META, slugify, type BuilderNode, type NodeType } from "./shared";

// ============================================================
// State shape
// ============================================================

export interface BuilderState {
  name: string;
  description: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  status: FlowRow["status"];
  nodes: BuilderNode[];
}

export interface FlowEditorContextValue {
  /** Immutable post-load envelope: id, created_at, fallback_policy, etc. */
  flow: FlowRow;

  // Authored state
  state: BuilderState;
  /**
   * Dirty-tracking React setState. Flips `dirty` on every call. Used
   * by the list view's existing subcomponents (Header, TriggerPanel,
   * EntryPicker) which mutate multiple fields atomically — granular
   * setters below would force them to fan out the update.
   */
  setState: (
    updaterOrValue:
      | BuilderState
      | ((prev: BuilderState) => BuilderState),
  ) => void;
  dirty: boolean;
  saving: boolean;
  activating: boolean;
  issues: ValidationIssue[];
  canActivate: boolean;

  // Node mutations. addNode returns the generated key so the caller
  // (a NodeCard "Add" button or canvas "+" button) can scroll to /
  // focus / open the new node.
  addNode: (type: NodeType) => string;
  updateNode: (key: string, patch: Partial<BuilderNode>) => void;
  updateNodeConfig: (key: string, patch: Record<string, unknown>) => void;
  updateNodePosition: (key: string, x: number, y: number) => void;
  updateNodePositions: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  removeNode: (key: string) => void;
  /**
   * Copia un nodo (con su contenido) y lo deja conectado detrás del
   * original cuando el paso tenía una sola salida. Devuelve la clave
   * nueva, o null si el nodo no existía.
   */
  duplicateNode: (key: string) => string | null;

  // Actions
  save: () => Promise<boolean>;
  setStatus: (status: BuilderState["status"]) => Promise<void>;
  deleteFlow: () => Promise<void>;

  /**
   * Transient "look here" signal. Set when the validation panel's
   * issue is clicked — both views subscribe: list scrolls the row
   * into view and flashes its border, canvas pans the viewport to
   * the node and flashes its card. Auto-clears after 1600ms so the
   * flash is a one-shot.
   *
   * Lives in context (not local view state) so the panel can be
   * rendered ONCE in the shell and trigger flashes in whichever
   * view is currently mounted, without per-view plumbing.
   */
  flashKey: string | null;
  requestFlash: (key: string) => void;
}

// ============================================================
// Helpers — node_key generation + per-type default configs
// ============================================================

export function uniqueNodeKey(base: string, existing: BuilderNode[]): string {
  if (!existing.some((n) => n.node_key === base)) return base;
  let i = 2;
  while (existing.some((n) => n.node_key === `${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

export function buildNewNode(type: NodeType, existing: BuilderNode[]): BuilderNode {
  const base = slugify(NODE_META[type].slugSeed, type);
  return {
    node_key: uniqueNodeKey(base, existing),
    node_type: type,
    config: defaultConfigFor(type),
  };
}

/**
 * Quita un nodo del flujo y repara el grafo a su alrededor.
 *
 * Si el nodo iba en línea recta —una sola flecha entrante y una sola
 * saliente— el nodo anterior se re-apunta al siguiente: borrar un paso
 * intermedio no deja la cadena cortada ni provoca errores en cascada
 * («falta el siguiente», «nodo inalcanzable»). En cualquier otro caso
 * (menú con varias salidas, condición, nodo de entrada) se sueltan las
 * referencias que apuntaban a él, que es el estado «sin destino» que ya
 * usan los formularios.
 *
 * Pura y exportada a propósito: el borrado del lienzo, el de la vista
 * de lista y el botón de la tarjeta pasan todos por aquí, y se puede
 * probar sin montar React.
 */
export function removeNodeFromState(state: BuilderState, key: string): BuilderState {
  if (!state.nodes.some((n) => n.node_key === key)) return state;

  const aristas = deriveCanvasEdges(state.nodes);
  const entrantes = aristas.filter((e) => e.target === key);
  const salientes = aristas.filter((e) => e.source === key);
  const sucesor = salientes.length === 1 ? salientes[0].target : null;
  const costura =
    sucesor && entrantes.length === 1
      ? { nodeKey: entrantes[0].source, slot: entrantes[0].sourceHandle }
      : null;

  let nodes = state.nodes.filter((n) => n.node_key !== key);
  if (costura && sucesor) {
    nodes = nodes.map((n) => {
      if (n.node_key !== costura.nodeKey) return n;
      const patch = applyEdgeConnection(n, costura.slot, sucesor);
      return patch ? { ...n, config: { ...n.config, ...patch } } : n;
    });
  } else {
    nodes = unlinkNodeReferences(nodes, key);
  }

  return {
    ...state,
    nodes,
    entry_node_id: state.entry_node_id === key ? null : state.entry_node_id,
  };
}

/**
 * Duplica un nodo.
 *
 * En los pasos de una sola salida (mensaje, archivo, preguntar,
 * etiqueta) la copia se **empalma justo detrás** del original: el
 * original pasa a apuntar a la copia y la copia hereda el destino que
 * tenía el original. Así «duplicar» deja un paso repetido y conectado,
 * sin errores que perseguir.
 *
 * En los nodos con varias salidas (menú, lista, condición) o
 * terminales, la copia conserva sus propias conexiones y se coloca al
 * lado, sin tocar el original: dos ramas pueden apuntar al mismo sitio.
 */
export function duplicateNodeInState(
  state: BuilderState,
  key: string,
  nuevoKey: string,
): BuilderState {
  const original = state.nodes.find((n) => n.node_key === key);
  if (!original) return state;

  const copia: BuilderNode = {
    ...original,
    node_key: nuevoKey,
    // Copia profunda: si se comparte el objeto, editar la copia
    // cambiaría también al original.
    config: JSON.parse(JSON.stringify(original.config)) as Record<string, unknown>,
  };

  const unaSalida =
    original.node_type === "send_message" ||
    original.node_type === "send_media" ||
    original.node_type === "collect_input" ||
    original.node_type === "set_tag";

  if (!unaSalida) {
    copia.position_x = (original.position_x ?? 0) + 280;
    copia.position_y = original.position_y ?? 0;
    return { ...state, nodes: [...state.nodes, copia] };
  }

  const destino = (original.config as { next_node_key?: string }).next_node_key ?? "";
  (copia.config as Record<string, unknown>).next_node_key = destino;

  // Entre el original y su siguiente, para que se vea dónde cayó.
  const siguienteNodo = state.nodes.find((n) => n.node_key === destino);
  copia.position_x = siguienteNodo
    ? Math.round(((original.position_x ?? 0) + (siguienteNodo.position_x ?? 0)) / 2)
    : original.position_x ?? 0;
  copia.position_y = siguienteNodo
    ? Math.round(((original.position_y ?? 0) + (siguienteNodo.position_y ?? 0)) / 2)
    : (original.position_y ?? 0) + 150;

  const nodes = state.nodes
    .map((n) =>
      n.node_key === key
        ? { ...n, config: { ...n.config, next_node_key: nuevoKey } }
        : n,
    )
    .concat(copia);
  return { ...state, nodes };
}

export function appendNode(state: BuilderState, node: BuilderNode): BuilderState {
  return {
    ...state,
    nodes: [...state.nodes, node],
    entry_node_id:
      state.entry_node_id ?? (node.node_type === "start" ? node.node_key : null),
  };
}

export function defaultConfigFor(type: NodeType): Record<string, unknown> {
  const t = getT("Flows.editorState");
  const tForm = getT("Flows.builder.form");
  switch (type) {
    case "start":
      return { next_node_key: "" };
    case "send_message":
      return { text: "", next_node_key: "" };
    case "send_buttons":
      return {
        text: "",
        buttons: [{ reply_id: "yes", title: t("defaultYes"), next_node_key: "" }],
      };
    case "send_list":
      return {
        text: "",
        button_label: t("defaultListButton"),
        sections: [
          {
            title: "",
            rows: [
              { reply_id: "row_1", title: tForm("optionN", { n: 1 }), next_node_key: "" },
            ],
          },
        ],
      };
    case "send_media":
      return {
        media_type: "image",
        media_url: "",
        caption: "",
        filename: "",
        next_node_key: "",
      };
    case "wait":
      // 15 s por defecto: tiempo de lectura humano sin frenar el embudo.
      return { segundos: 15, next_node_key: "" };
    case "save_reply":
      return {
        prompt_text: "",
        var_key: "respuesta",
        espera_minutos: 30,
        contesto_next: "",
        no_contesto_next: "",
      };
    case "collect_input":
      return {
        prompt_text: "",
        var_key: "answer",
        next_node_key: "",
      };
    case "condition":
      return {
        subject: "var",
        subject_key: "",
        operator: "equals",
        value: "",
        true_next: "",
        false_next: "",
      };
    case "set_tag":
      return { mode: "add", tag_id: "", next_node_key: "" };
    case "handoff":
      return { note: "" };
    case "end":
      return {};
  }
}

export function applyNodePositions(
  nodes: BuilderNode[],
  positions: Record<string, { x: number; y: number }>,
): BuilderNode[] {
  return nodes.map((n) => {
    const next = positions[n.node_key];
    return next
      ? {
          ...n,
          position_x: Math.round(next.x),
          position_y: Math.round(next.y),
        }
      : n;
  });
}

// ============================================================
// Context
// ============================================================

const FlowEditorCtx = createContext<FlowEditorContextValue | null>(null);

export function useFlowEditor(): FlowEditorContextValue {
  const ctx = useContext(FlowEditorCtx);
  if (!ctx) {
    throw new Error(
      "useFlowEditor must be called inside <FlowEditorProvider>",
    );
  }
  return ctx;
}

// ============================================================
// Provider
// ============================================================

interface ProviderProps {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
  children: ReactNode;
}

export function FlowEditorProvider({
  initialFlow,
  initialNodes,
  children,
}: ProviderProps) {
  const router = useRouter();
  const t = useTranslations("Flows.editorState");

  const [state, setStateRaw] = useState<BuilderState>(() => ({
    name: initialFlow.name,
    description: initialFlow.description ?? "",
    trigger_type: initialFlow.trigger_type,
    trigger_config: initialFlow.trigger_config as Record<string, unknown>,
    entry_node_id: initialFlow.entry_node_id,
    status: initialFlow.status,
    nodes: initialNodes.map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type as NodeType,
      config: n.config as Record<string, unknown>,
      position_x: n.position_x,
      position_y: n.position_y,
    })),
  }));

  const [saving, setSaving] = useState(false);
  const latestNodesRef = useRef(state.nodes);
  useEffect(() => {
    latestNodesRef.current = state.nodes;
  }, [state.nodes]);
  const [activating, setActivating] = useState(false);
  // dirty flips on user edits; status-only updates (after the activate
  // API succeeds) use setStateRaw so they don't falsely re-flag the
  // form as dirty.
  const [dirty, setDirty] = useState(false);
  const setState = useCallback<typeof setStateRaw>((updaterOrValue) => {
    setDirty(true);
    setStateRaw(updaterOrValue);
  }, []);

  // Cross-view "look here" signal (see FlowEditorContextValue docs).
  // Tracked via a ref alongside state so a rapid second click on a
  // different issue cancels the previous timeout instead of letting
  // the first flash linger past the new one.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const requestFlash = useCallback((key: string) => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    setFlashKey(key);
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashKey(null);
      flashTimeoutRef.current = null;
    }, 1600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    },
    [],
  );

  // Browser-level reload / tab-close / external-link guard. SPA
  // navigation (sidebar links, back button) isn't covered — Next 16
  // routes through the App Router and beforeunload doesn't fire on
  // client-side route changes. That's a follow-up; this catches the
  // accidental refresh / closed-window class of data loss.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the return value but require something
      // truthy to actually show the native prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ---- Validation ----
  const issues = useMemo<ValidationIssue[]>(
    () =>
      validateFlowForActivation(
        {
          name: state.name,
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          entry_node_id: state.entry_node_id,
        },
        state.nodes,
      ),
    [state],
  );
  const canActivate = useMemo(
    () => issues.every((i) => i.severity !== "error"),
    [issues],
  );

  // ---- Save (PUT) ----
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/flows/${initialFlow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.name,
          description: state.description || null,
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          entry_node_id: state.entry_node_id,
          nodes: state.nodes,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("saveFailedStatus", { status: res.status }));
      }
      setDirty(false);
      toast.success(t("saved"));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("saveFailed");
      toast.error(msg);
      return false;
    } finally {
      setSaving(false);
    }
  }, [initialFlow.id, state, t]);

  // ---- Activate / Pause / Archive ----
  const setStatus = useCallback(
    async (next: BuilderState["status"]) => {
      if (next === "active" && !canActivate) {
        toast.error(t("fixIssues"));
        return;
      }
      setActivating(true);
      try {
        // Always save first so the activation validator sees the
        // latest state — the user shouldn't have to remember "save
        // then activate".
        if (next === "active" && !(await save())) {
          return;
        }
        const res = await fetch(`/api/flows/${initialFlow.id}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? t("statusUpdateFailedStatus", { status: res.status }));
        }
        setStateRaw((s) => ({ ...s, status: next }));
        toast.success(
          next === "active"
            ? t("statusActivated")
            : next === "archived"
              ? t("statusArchived")
              : t("statusDraft")
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("statusUpdateFailed");
        toast.error(msg);
      } finally {
        setActivating(false);
      }
    },
    [canActivate, save, initialFlow.id, t],
  );

  // ---- Delete ----
  const deleteFlow = useCallback(async () => {
    const yes = window.confirm(t("deleteConfirm", { name: state.name }));
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${initialFlow.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(t("deleteFailedStatus", { status: res.status }));
      router.push("/flows");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("deleteFailed");
      toast.error(msg);
    }
  }, [initialFlow.id, router, state.name, t]);

  // ---- Node mutations ----
  const updateNode = useCallback(
    (key: string, patch: Partial<BuilderNode>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key ? { ...n, ...patch } : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodeConfig = useCallback(
    (key: string, configPatch: Record<string, unknown>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, config: { ...n.config, ...configPatch } }
            : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodePosition = useCallback(
    (key: string, x: number, y: number) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, position_x: Math.round(x), position_y: Math.round(y) }
            : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      // Initial Dagre layout hydration should not dirty the editor:
      // opening a legacy all-zero flow must not enable Save or arm
      // beforeunload before the user actually edits anything.
      setStateRaw((s) => ({
        ...s,
        nodes: applyNodePositions(s.nodes, positions),
      }));
    },
    [],
  );

  const addNode = useCallback(
    (type: NodeType): string => {
      const node = buildNewNode(type, latestNodesRef.current);
      latestNodesRef.current = [...latestNodesRef.current, node];
      setState((s) => appendNode(s, node));
      return node.node_key;
    },
    [setState],
  );

  const removeNode = useCallback(
    (key: string) => {
      setState((s) => removeNodeFromState(s, key));
    },
    [setState],
  );

  const duplicateNode = useCallback(
    (key: string): string | null => {
      // La clave nueva se calcula con la última foto conocida de los
      // nodos (igual que addNode) para poder devolverla sin esperar al
      // commit de React.
      const actual = latestNodesRef.current;
      const original = actual.find((n) => n.node_key === key);
      if (!original) return null;
      const nuevoKey = uniqueNodeKey(original.node_key, actual);
      setState((s) => duplicateNodeInState(s, key, nuevoKey));
      return nuevoKey;
    },
    [setState],
  );

  const value = useMemo<FlowEditorContextValue>(
    () => ({
      flow: initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      duplicateNode,
      save,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
    }),
    [
      initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      duplicateNode,
      save,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
    ],
  );

  return <FlowEditorCtx.Provider value={value}>{children}</FlowEditorCtx.Provider>;
}
