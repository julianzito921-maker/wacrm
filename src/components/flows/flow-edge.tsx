"use client";

/**
 * Conector del lienzo, editable desde la propia línea.
 *
 * En el punto medio de cada flecha hay dos iconos:
 *   - ➕ inserta un paso nuevo justo ahí (el origen pasa a apuntar al
 *     nuevo nodo y el nuevo nodo apunta al destino que tenía la línea).
 *   - 🗑 quita la conexión (vacía el «a dónde sigue» del nodo de origen,
 *     que es lo único que sostiene la unión).
 *
 * Por qué una arista propia: con las flechas por defecto había que
 * abrir el nodo de origen y editar el desplegable «Avanza a» para
 * deshacer una unión, o adivinar qué botón correspondía a cada línea.
 * Con los iconos en la línea, lo que se ve es lo que se toca.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { applyEdgeConnection } from "@/lib/flows/edges";
import { useFlowEditor } from "./flow-editor-state";

export function FlowEdge({
  id,
  source,
  target,
  sourceHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  labelStyle,
}: EdgeProps) {
  const t = useTranslations("Flows.builder");
  const { state, addNode, updateNodeConfig, updateNodePosition } = useFlowEditor();

  const [ruta, mitadX, mitadY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const origen = state.nodes.find((n) => n.node_key === source);

  const quitar = () => {
    if (!origen || !sourceHandleId) return;
    const patch = applyEdgeConnection(origen, sourceHandleId, "");
    if (patch) updateNodeConfig(source, patch);
  };

  const insertar = () => {
    if (!origen || !sourceHandleId) return;
    const nuevo = addNode("send_message");
    const patch = applyEdgeConnection(origen, sourceHandleId, nuevo);
    if (patch) updateNodeConfig(source, patch);
    // El paso nuevo hereda el destino que tenía la línea y se coloca
    // justo en el hueco, para que la cadena siga contando la misma
    // historia con un paso más en el medio.
    updateNodeConfig(nuevo, { next_node_key: target });
    updateNodePosition(nuevo, mitadX, mitadY);
  };

  return (
    <>
      <BaseEdge id={id} path={ruta} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${mitadX}px, ${mitadY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan flex flex-col items-center gap-1"
        >
          {label ? (
            <span
              style={labelStyle}
              className="bg-card text-muted-foreground rounded border border-border px-1.5 py-0.5 text-[10px]"
            >
              {String(label)}
            </span>
          ) : null}
          <span className="border-border bg-card flex items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-sm">
            <button
              type="button"
              title={t("edgeInsert")}
              aria-label={t("edgeInsert")}
              onClick={(e) => {
                e.stopPropagation();
                insertar();
              }}
              className="text-muted-foreground hover:bg-primary/10 hover:text-primary flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              title={t("edgeRemove")}
              aria-label={t("edgeRemove")}
              onClick={(e) => {
                e.stopPropagation();
                quitar();
              }}
              className="text-muted-foreground hover:bg-red-500/10 hover:text-red-500 flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
