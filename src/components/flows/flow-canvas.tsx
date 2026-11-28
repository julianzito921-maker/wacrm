'use client';

/**
 * Canvas / mind-map view of a flow. Editable, in parity with the
 * list view for everything except the trigger / header / fallback
 * panels (those are list-only — they don't fit visually inside a
 * node graph and the user can switch to List for them).
 *
 * What this view does:
 *   - Renders every flow_node as a draggable tile, pan + zoom +
 *     minimap. Drag positions persist via the editor context
 *     (writing on dragStop, not every frame).
 *   - Renders edges between nodes, labeled per slot (button title,
 *     "true" / "false", list row title) so a branching flow reads
 *     as a real decision tree.
 *   - Click a node → a centered editor window (estilo Leona) opens
 *     with the same per-node form the list view uses, plus "Set as
 *     entry" / "Delete". Validation issues show as a badge on each
 *     card instead of a fixed bar under the canvas.
 *   - Drag from a source handle on one node to a target handle on
 *     another → wires that slot's `next_node_key`. Per-slot handles
 *     for multi-outgoing types (condition, send_buttons, send_list)
 *     so the user picks which branch they're wiring.
 *   - Backspace / Delete on a selected node → removes it AND clears
 *     every inbound `next_node_key` reference (no dangling arrows).
 *   - Delete on a selected edge → clears just that slot.
 *   - "+ Add node" floating button drops a new node at the visible
 *     viewport center.
 *   - Runs dagre auto-layout once on mount for flows whose
 *     `position_x` / `position_y` are all zero (pre-canvas flows
 *     and brand-new flows) — otherwise everything would pile at
 *     the origin.
 *
 * The toggle in `flow-editor-shell.tsx` swaps this in for
 * `<FlowBuilder>` on the same page. Both views share the same
 * `BuilderState` via `useFlowEditor()` — toggling never resets
 * unsaved edits, and a drag here updates the same nodes array the
 * list view reads.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CircleAlert, Maximize2, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-react';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  applyEdgeConnection,
  deriveCanvasEdges,
} from '@/lib/flows/edges';
import { autoLayout, shouldAutoLayout } from '@/lib/flows/layout';
import {
  DND_BLOQUE,
  NodeIconChip,
  configAtajoMedio,
  nodeColors,
  type BuilderNode,
} from './shared';
import { ANCHO_TARJETA, GRIS_CONECTOR, TarjetaNodo, type DatosTarjeta } from './tarjeta-nodo';
import { useFlowEditor } from './flow-editor-state';
import { FlowEdge } from './flow-edge';
import { NodeConfigForm } from './forms/node-config-form';
import type { CargaArrastre } from './flow-palette';
import { IssueLine } from './validation-panel';
import type { ValidationIssue } from '@/lib/flows/validate';

// React-Flow node `data` payload — lo que pinta la tarjeta.
type NodeData = DatosTarjeta;

const NODE_WIDTH = ANCHO_TARJETA;
// Best-effort default; actual height varies by summary length but
// dagre needs SOMETHING to compute rank spacing. Underestimating is
// safer than over (tighter layout that still doesn't overlap).
const NODE_HEIGHT = 200; // cabecera 60 + métricas 45 + contenido (diseño Leona)

/** «Palabra clave: chía, hola», «Cualquier mensaje», etc. */
function resumenDisparador(
  tipo: string,
  config: Record<string, unknown>,
  t: ReturnType<typeof useTranslations>,
): string {
  if (tipo === 'keyword') {
    const claves = Array.isArray(config.keywords) ? (config.keywords as string[]).filter(Boolean) : [];
    return claves.length > 0
      ? `${t('triggerKeywordTitle')}: ${claves.join(', ')}`
      : t('triggerKeywordsMissing');
  }
  if (tipo === 'any_message') return t('triggerAnyMessageTitle');
  if (tipo === 'first_inbound_message') return t('triggerFirstInboundTitle');
  return t('triggerManualTitle');
}

/**
 * Envoltura de cada tarjeta: le pone el globo de avisos de validación
 * (rojo = error, ámbar = advertencia) en la esquina. Los avisos del
 * disparador y del flujo entero van en el Inicio, que es donde se ve el disparador.
 */
function TarjetaConAvisos(props: NodeProps) {
  const { issues } = useFlowEditor();
  const { node } = props.data as NodeData;
  const propios = issues.filter(
    (i) =>
      i.node_key === node.node_key ||
      (!i.node_key && node.node_type === 'start')
  );
  return (
    <div className="relative">
      <TarjetaNodo data={props.data} selected={props.selected} />
      {propios.length > 0 && <GloboAvisos issues={propios} />}
    </div>
  );
}

function GloboAvisos({ issues }: { issues: ValidationIssue[] }) {
  const hayError = issues.some((i) => i.severity === 'error');
  return (
    <div className="group/aviso absolute -top-2.5 -right-2.5 z-20">
      <span
        aria-label={issues.map((i) => i.message).join(' · ')}
        className={cn(
          'flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-bold text-white shadow-[0_0_0_2px_var(--canvas)]',
          hayError ? 'bg-red-500' : 'bg-amber-500'
        )}
      >
        <CircleAlert className="h-3 w-3" />
        {issues.length > 1 && issues.length}
      </span>
      {/* Al pasar el ratón: los avisos completos, sin salir del lienzo. */}
      <div className="pointer-events-none absolute right-0 bottom-full z-30 mb-1.5 hidden w-72 rounded-lg border border-border bg-popover p-1.5 shadow-xl group-hover/aviso:block">
        {issues.map((i, ix) => (
          <IssueLine key={ix} issue={i} />
        ))}
      </div>
    </div>
  );
}

const NODE_TYPES = { flow: TarjetaConAvisos };

// Un solo tipo de arista, con los iconos de quitar/insertar en la línea.
// Constante de módulo a propósito: React-Flow avisa si el objeto cambia
// de identidad en cada render.
const EDGE_TYPES = { flujo: FlowEdge };

/** Alejar · Acercar | Ajustar vista · Restablecer vista (Leona). */
function ControlesZoom() {
  const t = useTranslations('Flows.builder');
  const rf = useReactFlow();
  const botones = [
    { label: t('zoomOut'), icon: ZoomOut, accion: () => rf.zoomOut({ duration: 200 }), chico: false },
    { label: t('zoomIn'), icon: ZoomIn, accion: () => rf.zoomIn({ duration: 200 }), chico: false },
    { label: t('fitView'), icon: Maximize2, accion: () => rf.fitView({ padding: 0.2, duration: 300 }), chico: true },
    { label: t('resetView'), icon: RotateCcw, accion: () => rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 }), chico: true },
  ];
  return (
    <div className="flex items-center gap-[1.9px] rounded-[7.5px] border border-[#362c64] bg-[#161229] p-[1.9px]">
      {botones.map((b, i) => (
        <Fragment key={b.label}>
          {i === 2 && <span className="mx-[3px] h-5 w-px bg-[#362c64]" />}
          <button
            type="button"
            title={b.label}
            aria-label={b.label}
            onClick={b.accion}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[7.5px] text-slate-300 transition-colors hover:bg-[#241e42] hover:text-white"
          >
            <b.icon className={b.chico ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </button>
        </Fragment>
      ))}
    </div>
  );
}

// ============================================================
// Root canvas
// ============================================================

/**
 * Outer wrapper provides the React-Flow context to the inner body,
 * so `useReactFlow()` works from anywhere in `FlowCanvasInner`
 * (notably, the pan-to-flash effect). The split is required because
 * useReactFlow() must be called inside a ReactFlowProvider.
 */
export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner() {
  const t = useTranslations('Flows.builder');
  const {
    state,
    setState,
    updateNodeConfig,
    updateNodePosition,
    updateNodePositions,
    removeNode,
    flashKey,
    flow,
    saving,
  } = useFlowEditor();
  const reactFlow = useReactFlow();
  const builderNodes = state.nodes;
  const entryNodeId = state.entry_node_id;

  // Métricas de la tarjeta de «Esperar respuesta». Se recargan cuando
  // termina un guardado; si fallan, la tarjeta muestra «—».
  const [stats, setStats] = useState<
    Record<string, { entradas: number; avances: number }>
  >({});
  useEffect(() => {
    if (saving) return;
    let vivo = true;
    void (async () => {
      try {
        const res = await fetch(`/api/flows/${flow.id}/stats`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          nodes?: Array<{ node_key: string; entradas: number; avances: number }>;
        };
        if (!vivo) return;
        const mapa: Record<string, { entradas: number; avances: number }> = {};
        for (const f of json.nodes ?? []) {
          mapa[f.node_key] = { entradas: f.entradas, avances: f.avances };
        }
        setStats(mapa);
      } catch {
        // Cosmético: sin métricas la tarjeta sigue funcionando.
      }
    })();
    return () => {
      vivo = false;
    };
  }, [flow.id, saving]);

  // Side-panel state — which node's form is open. Canvas-only UI; the
  // list view's analogue is the per-card expanded set in
  // flow-builder.tsx.
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const selectedNode = useMemo(
    () =>
      selectedNodeKey
        ? (builderNodes.find((n) => n.node_key === selectedNodeKey) ?? null)
        : null,
    [selectedNodeKey, builderNodes]
  );

  const autoLayoutPositions = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(builderNodes);

    return shouldAutoLayout(builderNodes)
      ? autoLayout(
          builderNodes.map((n) => ({
            id: n.node_key,
            width: NODE_WIDTH,
            // La tarjeta de «Esperar respuesta» es más alta (métricas +
            // dos cajas de salida).
            height: n.node_type === 'save_reply' ? 300 : n.node_type === 'sale_approved' ? 140 : NODE_HEIGHT,
          })),
          canvasEdges.map((e) => ({ source: e.source, target: e.target })),
          { direction: 'TB' }
        )
      : null;
  }, [builderNodes]);

  // If dagre had to place an all-zero flow, persist the generated
  // positions into editor state once. Otherwise the next drag would
  // save only the dragged node and every other node would fall back
  // to (0,0), which feels like nodes teleporting around the canvas.
  const persistedAutoLayoutRef = useRef(false);
  useEffect(() => {
    if (!autoLayoutPositions || persistedAutoLayoutRef.current) return;
    persistedAutoLayoutRef.current = true;
    updateNodePositions(
      Object.fromEntries(
        [...autoLayoutPositions].map(([key, pos]) => [key, pos])
      )
    );
  }, [autoLayoutPositions, updateNodePositions]);

  const derivedRfNodes = useMemo(() => {
    const nodes: RfNode<NodeData>[] = builderNodes.map((n) => {
      const fallback = autoLayoutPositions?.get(n.node_key);
      return {
        id: n.node_key,
        type: 'flow',
        position: {
          x: fallback?.x ?? n.position_x ?? 0,
          y: fallback?.y ?? n.position_y ?? 0,
        },
        data: {
          node: n,
          isEntry: n.node_key === entryNodeId,
          isFlashed: n.node_key === flashKey,
          stats: stats[n.node_key],
          onEdit: setSelectedNodeKey,
          disparador:
            n.node_type === 'start'
              ? resumenDisparador(state.trigger_type, state.trigger_config, t)
              : undefined,
        },
      };
    });

    return nodes;
  }, [builderNodes, entryNodeId, flashKey, autoLayoutPositions, stats, state.trigger_type, state.trigger_config, t]);

  const [rfNodes, setRfNodes] = useState<RfNode<NodeData>[]>(derivedRfNodes);

  useEffect(() => {
    setRfNodes(derivedRfNodes);
  }, [derivedRfNodes]);

  // Las flechas salen de la MISMA lista que React-Flow está pintando
  // (rfNodes), no de `builderNodes`: si se derivan de otra lista, en el
  // render en que se borra un nodo las flechas todavía lo referencian y
  // React-Flow escupe errores de handles inexistentes.
  const rfEdges = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(rfNodes.map((n) => n.data.node));

    // sourceHandle is now wired up — the FlowNodeCard renders a Handle
    // per slot whose id matches the scheme in edges.ts, so React-Flow
    // can hang the arrow off the right place on each card.
    const rfEdges: RfEdge[] = canvasEdges.map((e) => ({
      id: e.id,
      type: 'flujo',
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      animated: true,
      style: {
        stroke: GRIS_CONECTOR,
        strokeWidth: 3,
        strokeDasharray: '8 4',
      },
    }));

    return rfEdges;
  }, [rfNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<RfNode<NodeData>>[]) => {
      setRfNodes((nodes) => applyNodeChanges(changes, nodes));
    },
    []
  );

  // Drag-to-position: React-Flow tracks the visual drag internally and
  // fires this once on release. We write the final coordinate back to
  // the editor context (which flips `dirty`); save then ships the new
  // positions in the existing PUT /api/flows/[id] body (the route
  // already destructures position_x / position_y per migration 010).
  // Writing only on dragStop (not on every position-change tick during
  // the drag) keeps state updates cheap on long drags.
  const handleNodeDragStop = useCallback<OnNodeDrag<RfNode<NodeData>>>(
    (_event, node) => {
      updateNodePosition(node.id, node.position.x, node.position.y);
    },
    [updateNodePosition]
  );

  // Pan to the flashed node when the validator panel requests one.
  // Animate over 400ms; landing zoom is whatever the user already has
  // (don't force a zoom reset — that would be jarring mid-edit).
  useEffect(() => {
    if (!flashKey) return;
    const node = builderNodes.find((n) => n.node_key === flashKey);
    if (!node) return;
    const x = (node.position_x ?? 0) + NODE_WIDTH / 2;
    const y = (node.position_y ?? 0) + NODE_HEIGHT / 2;
    reactFlow.setCenter(x, y, {
      zoom: reactFlow.getZoom(),
      duration: 400,
    });
  }, [flashKey, builderNodes, reactFlow]);

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: RfNode<NodeData>) => {
      setSelectedNodeKey(node.id);
    },
    []
  );

  // Drag-to-connect: React-Flow fires onConnect when the user drops a
  // handle drag onto a target handle. We look up the source node,
  // compute the right config patch via applyEdgeConnection (matches
  // the same slot scheme as deriveCanvasEdges), and dispatch via
  // updateNodeConfig. The resulting state change re-derives edges on
  // the next render — no need to maintain a separate edge list.
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle
      ) {
        return;
      }
      const sourceNode = builderNodes.find(
        (n) => n.node_key === connection.source
      );
      if (!sourceNode) return;
      // Self-loops are a footgun (a button whose target is its own
      // node = infinite reprompt). Reject silently — the user can
      // still wire one via the per-node dropdown if they really want.
      if (connection.source === connection.target) return;
      const patch = applyEdgeConnection(
        sourceNode,
        connection.sourceHandle,
        connection.target
      );
      if (patch) updateNodeConfig(connection.source, patch);
    },
    [builderNodes, updateNodeConfig]
  );

  // Keyboard delete (Backspace / Delete) + drag-to-trash. React-Flow
  // fires this with the set of deleted-node objects; we route each
  // through the editor context's removeNode (which now also unlinks
  // inbound references so no dangling arrows survive). Closing the
  // side panel on delete keeps the UI honest if the user deleted the
  // node currently being edited.
  const handleNodesDelete = useCallback(
    (deleted: RfNode<NodeData>[]) => {
      for (const n of deleted) {
        removeNode(n.id);
        if (selectedNodeKey === n.id) setSelectedNodeKey(null);
      }
    },
    [removeNode, selectedNodeKey]
  );

  // Edge delete: clear the source node's slot rather than removing
  // anything. Edges are derived from configs, so the only way to
  // "delete" one is to null out its underlying next_node_key.
  const handleEdgesDelete = useCallback(
    (deleted: RfEdge[]) => {
      for (const e of deleted) {
        if (!e.sourceHandle) continue;
        const sourceNode = builderNodes.find((n) => n.node_key === e.source);
        if (!sourceNode) continue;
        const patch = applyEdgeConnection(sourceNode, e.sourceHandle, '');
        if (patch) updateNodeConfig(e.source, patch);
      }
    },
    [builderNodes, updateNodeConfig]
  );

  // Wrapped mutators that target the currently-selected node — pass to
  // the form so each keystroke goes through the editor context (which
  // flips `dirty` and feeds the validator).
  const onSelectedUpdateConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (selectedNodeKey) updateNodeConfig(selectedNodeKey, patch);
    },
    [selectedNodeKey, updateNodeConfig]
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selectedNodeKey) return;
    removeNode(selectedNodeKey);
    setSelectedNodeKey(null);
  }, [selectedNodeKey, removeNode]);

  // Soltar un bloque del panel flotante: el nodo nace donde se suelta.
  const { addNode } = useFlowEditor();
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_BLOQUE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const crudo = e.dataTransfer.getData(DND_BLOQUE);
      if (!crudo) return;
      e.preventDefault();
      let carga: CargaArrastre;
      try {
        carga = JSON.parse(crudo) as CargaArrastre;
      } catch {
        return;
      }
      const punto = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const key = addNode(carga.tipo);
      if (carga.medio) {
        updateNodeConfig(
          key,
          carga.tipo === 'send_message'
            ? configAtajoMedio(carga.medio)
            : { media_type: carga.medio },
        );
      }
      updateNodePosition(key, punto.x - NODE_WIDTH / 2, punto.y - 24);
    },
    [addNode, reactFlow, updateNodeConfig, updateNodePosition]
  );

  const handleSetEntry = useCallback(() => {
    if (!selectedNodeKey) return;
    setState((s) => ({ ...s, entry_node_id: selectedNodeKey }));
  }, [selectedNodeKey, setState]);

  return (
    <>
      <div
        className="bg-canvas h-full w-full overflow-hidden"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeDoubleClick={handleNodeDoubleClick}
          zoomOnDoubleClick={false}
          onConnect={handleConnect}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          // Como Leona: clic en la línea = quitarla.
          onEdgeClick={(_, edge) => handleEdgesDelete([edge])}
          // Flechas más fáciles de acertar con el ratón (zona de clic).
          defaultEdgeOptions={{ interactionWidth: 20 }}
          // Default is "Backspace" only — accept both so Mac users
          // hitting Delete (Fn+Backspace) get the same behavior.
          deleteKeyCode={['Backspace', 'Delete']}
          nodesConnectable={true}
          edgesFocusable={true}
          elementsSelectable={true}
          // Lower default min/max zoom than the lib's defaults; the
          // tiles already truncate their summary at a reasonable
          // size, so we don't need to zoom past 1.5x.
          minZoom={0.2}
          maxZoom={1.5}
        >
          {/* Dot grid, matching the design's faint canvas backdrop. */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="rgba(226, 232, 240, 0.42)"
            bgColor="#1d1939"
          />
          {/* Como Leona: zoom abajo a la izquierda y minimapa abajo a la derecha. */}
          <Panel position="bottom-left" className="!m-[11px]">
            <ControlesZoom />
          </Panel>
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              nodeColors((n.data as NodeData).node.node_type).solid
            }
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            position="bottom-right"
            bgColor="#161229"
            maskColor="rgba(0, 0, 0, 0.6)"
            style={{ width: 250, height: 180 }}
            className="!m-[27px] !overflow-hidden !rounded-[8px] !border !border-[#362c64]"
          />
          {rfNodes.length === 0 && (
            <Panel position="top-center" className="!top-1/3">
              <p className="text-muted-foreground border-sidebar-border bg-sidebar/80 rounded-lg border px-4 py-2.5 text-sm backdrop-blur-md">
                {t('canvasEmptyHint')}
              </p>
            </Panel>
          )}
        </ReactFlow>
      </div>

      <NodeEditDialog
        node={selectedNode}
        isEntry={selectedNode?.node_key === entryNodeId}
        allNodes={builderNodes}
        onClose={() => setSelectedNodeKey(null)}
        onUpdateConfig={onSelectedUpdateConfig}
        onDelete={handleDeleteSelected}
        onSetEntry={handleSetEntry}
        t={t}
      />
    </>
  );
}

// ============================================================
// Ventana de edición, igual a Leona: 480 px de ancho y todo el alto,
// «Editar <bloque>» arriba y «Cancelar / Guardar» abajo. Los cambios se
// ven en vivo en la tarjeta; «Cancelar» (o la X / Esc) devuelve el bloque
// a como estaba al abrir, «Guardar» los deja. Clic fuera no cierra, para
// no perder lo escrito.
// ============================================================

function NodeEditDialog({
  node,
  isEntry,
  allNodes,
  onClose,
  onUpdateConfig,
  onDelete,
  onSetEntry,
  t,
}: {
  node: BuilderNode | null;
  isEntry: boolean;
  allNodes: BuilderNode[];
  onClose: () => void;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onSetEntry: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { issues, setState } = useFlowEditor();
  const open = node !== null;

  // Foto del bloque al abrir, para que «Cancelar» lo deje como estaba.
  const foto = useRef<{ key: string; config: BuilderNode['config'] } | null>(null);
  useEffect(() => {
    if (node && foto.current?.key !== node.node_key) {
      foto.current = { key: node.node_key, config: structuredClone(node.config) };
    }
    if (!node) foto.current = null;
  }, [node]);

  const cancelar = () => {
    const f = foto.current;
    if (f) {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) => (n.node_key === f.key ? { ...n, config: f.config } : n)),
      }));
    }
    onClose();
  };

  const propios = node
    ? issues.filter(
        (i) =>
          i.node_key === node.node_key ||
          (!i.node_key && node.node_type === 'start')
      )
    : [];
  const titulo = node ? t(`nodes.${node.node_type}.label`) : '';
  return (
    <Dialog open={open} onOpenChange={(v) => !v && cancelar()} disablePointerDismissal>
      {node && (
        <DialogContent
          overlayClassName="bg-black/60"
          className="flex h-[calc(100vh-46px)] max-h-[860px] flex-col gap-0 overflow-hidden rounded-[3.75px] border border-[#251e45] bg-[#110e20] p-0 sm:max-w-[480px]"
        >
          <div className="flex items-center gap-3 border-b border-[#251e45] px-5 py-[22px] pr-12">
            <NodeIconChip type={node.node_type} size={34} iconSize={18} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2 text-[16.9px] font-semibold text-slate-50">
                {t('editTitle', { block: titulo.toLowerCase() })}
                {isEntry && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-emerald-300 uppercase">
                    {t('badgeEntry')}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t(`nodes.${node.node_type}.blurb`)}
              </DialogDescription>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
            {propios.length > 0 && (
              <div
                className={cn(
                  'rounded-lg border p-1.5',
                  propios.some((i) => i.severity === 'error')
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-amber-500/40 bg-amber-500/5'
                )}
              >
                {propios.map((i, ix) => (
                  <IssueLine key={ix} issue={i} />
                ))}
              </div>
            )}
            <NodeConfigForm
              node={node}
              allNodes={allNodes}
              showAdvanced={false}
              onUpdateConfig={onUpdateConfig}
            />
          </div>

          <div className="flex items-center gap-2 border-t border-[#251e45] px-5 py-3">
            {node.node_type !== 'start' && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onDelete}
                title={t('deleteNode')}
                aria-label={t('deleteNode')}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {!isEntry && !allNodes.some((n) => n.node_type === 'start') && (
              <Button variant="ghost" size="sm" onClick={onSetEntry}>
                {t('setAsEntry')}
              </Button>
            )}
            <Button variant="outline" size="sm" className="ml-auto min-w-24" onClick={cancelar}>
              {t('cancelEditing')}
            </Button>
            <Button size="sm" className="min-w-24 bg-[#8b5cf6] text-white hover:bg-[#7c3aed]" onClick={onClose}>
              {t('saveEditing')}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
