"use client";

/**
 * Herramientas y Simular, igual que en Leona (medido el 27-nov-2026).
 *
 * Arriba a la izquierda del lienzo, bajo la barra flotante, hay dos
 * botones: «Herramientas» (morado, 34 px) y «Simular» (oscuro). Cada uno
 * abre su panel justo debajo:
 *   - Herramientas (240 × hasta 500 px): «Buscar bloques…» y la lista de
 *     bloques con su ícono de color. Clic = agregar; arrastrar = soltar
 *     donde se quiera en el lienzo.
 *   - Simular (360 × 520 px): prueba local, sin WhatsApp y sin guardar.
 */

import { useMemo, useState } from "react";
import { FlaskConical, Search, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { useFlowEditor } from "./flow-editor-state";
import { FlowPreview } from "./flow-preview";
import { CATALOGO_BLOQUES, DND_BLOQUE, nodeColors, type NodeType } from "./shared";

/** Lo que viaja en el arrastre: el lienzo lo lee al soltar. */
export interface CargaArrastre {
  tipo: NodeType;
  medio?: "image" | "video" | "document" | "audio";
}

const PANEL =
  "pointer-events-auto flex flex-col overflow-hidden rounded-[7.5px] border border-[#362c64] bg-[#161229] shadow-[0_18px_48px_-18px_rgba(0,0,0,0.8)]";

export function FlowPalette({
  className,
  onEditarDesdeSimulacion,
}: {
  className?: string;
  /** «Editar» en la simulación: lleva al nodo en la vista Lista. */
  onEditarDesdeSimulacion?: (key: string) => void;
}) {
  const tc = useTranslations("Flows.catalog");
  const { addNode, requestFlash } = useFlowEditor();
  const [abierto, setAbierto] = useState<"herramientas" | "simular" | null>(null);
  const [busqueda, setBusqueda] = useState("");

  const agregar = (tipo: NodeType) => {
    const key = addNode(tipo);
    requestFlash(key);
  };

  const alArrastrar = (e: React.DragEvent, carga: CargaArrastre) => {
    e.dataTransfer.setData(DND_BLOQUE, JSON.stringify(carga));
    e.dataTransfer.effectAllowed = "copy";
  };

  const filtro = busqueda.trim().toLowerCase();
  const bloques = useMemo(
    () =>
      CATALOGO_BLOQUES.filter(
        (b) => b.tipo && (!filtro || tc(`${b.id}.label`).toLowerCase().includes(filtro)),
      ),
    [filtro, tc],
  );

  const alternar = (p: "herramientas" | "simular") =>
    setAbierto((actual) => (actual === p ? null : p));

  return (
    <div className={cn("flex flex-col items-start gap-[11px]", className)}>
      <div className="pointer-events-auto flex gap-1.5">
        <button
          type="button"
          aria-pressed={abierto === "herramientas"}
          onClick={() => alternar("herramientas")}
          className="inline-flex h-[34px] items-center gap-2 rounded-[7.5px] bg-[#8b5cf6] px-4 text-[13px] font-medium text-white shadow-[0_6px_18px_-8px_#8b5cf6] transition-colors hover:bg-[#7c3aed]"
        >
          <Wrench className="h-4 w-4" />
          {tc("tabTools")}
        </button>
        <button
          type="button"
          aria-pressed={abierto === "simular"}
          onClick={() => alternar("simular")}
          className={cn(
            "inline-flex h-[34px] items-center gap-2 rounded-[7.5px] border px-4 text-[13px] font-medium transition-colors",
            abierto === "simular"
              ? "border-[#8b5cf6] bg-[#241e42] text-white"
              : "border-[#362c64] bg-[#161229] text-slate-200 hover:bg-[#241e42]",
          )}
        >
          <FlaskConical className="h-4 w-4" />
          {tc("tabSimulate")}
        </button>
      </div>

      {abierto === "herramientas" && (
        <aside className={cn(PANEL, "max-h-[min(500px,calc(100%-45px))] w-[240px]")}>
          <div className="shrink-0 border-b border-[#251e45] p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder={tc("search")}
                aria-label={tc("search")}
                autoComplete="off"
                spellCheck={false}
                className="h-9 w-full rounded-lg border border-[#251e45] bg-[#1c1734] pr-3 pl-9 text-sm font-medium text-slate-50 outline-none transition-colors placeholder:text-slate-500 hover:border-[#362c64] focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/30"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2 pb-4">
            {bloques.map((b) => (
              <button
                key={b.id}
                type="button"
                draggable
                onDragStart={(e) => alArrastrar(e, { tipo: b.tipo! })}
                onClick={() => agregar(b.tipo!)}
                title={tc("dragHint")}
                className="flex h-[34px] w-full cursor-grab items-center gap-3 rounded-lg px-2.5 text-left text-[13px] font-medium text-slate-50 transition-colors hover:bg-[#241e42] active:cursor-grabbing"
              >
                <b.icon
                  className="h-[18px] w-[18px] shrink-0"
                  style={{ color: nodeColors(b.tipo!).solid }}
                />
                <span className="truncate">{tc(`${b.id}.label`)}</span>
              </button>
            ))}
            {bloques.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-slate-400">{tc("noResults")}</p>
            )}
          </div>
        </aside>
      )}

      {abierto === "simular" && (
        <aside className={cn(PANEL, "h-[min(520px,calc(100%-45px))] w-[360px]")}>
          <div className="shrink-0 border-b border-[#251e45] px-3 py-2.5">
            <p className="text-[13px] font-semibold text-slate-50">{tc("simulatorTitle")}</p>
            <p className="text-[11px] text-slate-400">{tc("simulatorHint")}</p>
          </div>
          <div className="relative min-h-0 flex-1">
            <FlowPreview onEdit={(key) => onEditarDesdeSimulacion?.(key)} />
          </div>
        </aside>
      )}
    </div>
  );
}
