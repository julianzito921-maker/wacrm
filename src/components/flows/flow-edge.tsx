"use client";

/**
 * Conector del lienzo, igual que en Leona: línea gris punteada, sin
 * botones encima. Al pasar el ratón se pone roja y el cursor cambia a
 * «manita»; un clic la quita (el lienzo vacía el «a dónde sigue» del
 * nodo de origen, que es lo único que sostiene la unión). Si entre dos
 * bloques hay dos líneas (p. ej. «sí» y «no» al mismo destino), cada una
 * es su propia ruta y el clic quita solo la que se tocó.
 */

import { useState } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";

export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const t = useTranslations("Flows.builder");
  const [encima, setEncima] = useState(false);
  const [ruta] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <g
      onMouseEnter={() => setEncima(true)}
      onMouseLeave={() => setEncima(false)}
      style={{ cursor: "pointer" }}
    >
      <title>{t("edgeClickToRemove")}</title>
      <BaseEdge
        id={id}
        path={ruta}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={encima ? { ...style, stroke: "#ef4444" } : style}
      />
    </g>
  );
}
