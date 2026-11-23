"use client";

/**
 * Panel flotante de bloques (rediseño del 22-nov-2026).
 *
 * Vive DENTRO del lienzo, arriba a la izquierda, sobre un fondo
 * `--sidebar` translúcido. Dos pestañas:
 *   - Herramientas: buscador «Buscar bloques…» y el catálogo completo.
 *     Los bloques que el motor ya ejecuta se agregan con un clic o se
 *     arrastran al lienzo (y caen donde se sueltan). Los demás se ven
 *     como «Próximamente» y no se pueden agregar.
 *   - Simular: la vista previa del flujo tal como le llega a la clienta.
 *
 * El bloque «Mensaje» trae atajos de imagen, video, documento y nota de
 * voz (nodo send_media), que son la mayoría de un embudo de WhatsApp.
 */

import { useMemo, useState } from "react";
import { ChevronsLeft, ChevronsRight, FlaskConical, Search, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { useFlowEditor } from "./flow-editor-state";
import { FlowPreview } from "./flow-preview";
import {
  ATAJOS_MEDIA,
  CATALOGO_BLOQUES,
  configAtajoMedio,
  DND_BLOQUE,
  nodeColors,
  type Bloque,
  type NodeType,
} from "./shared";

type Medio = (typeof ATAJOS_MEDIA)[number]["medio"];

/** Lo que viaja en el arrastre: el lienzo lo lee al soltar. */
export interface CargaArrastre {
  tipo: NodeType;
  medio?: Medio;
}

const TONO: Record<Bloque["tono"], string> = {
  violeta: "#8b6bff",
  azul: "#4b8bff",
};

export function FlowPalette({
  className,
  onEditarDesdeSimulacion,
}: {
  className?: string;
  /** «Editar» en la simulación: lleva al nodo en la vista Lista. */
  onEditarDesdeSimulacion?: (key: string) => void;
}) {
  const t = useTranslations("Flows.builder");
  const tc = useTranslations("Flows.catalog");
  const { addNode, updateNodeConfig, requestFlash } = useFlowEditor();
  const [pestana, setPestana] = useState<"herramientas" | "simular">("herramientas");
  const [busqueda, setBusqueda] = useState("");
  const [plegado, setPlegado] = useState(false);

  const agregar = (tipo: NodeType, medio?: Medio) => {
    // «Inicio» solo hay uno: si ya existe, addNode lo devuelve y se resalta.
    const key = addNode(tipo);
    // Atajo de multimedia: un Mensaje que ya trae esa burbuja.
    if (medio) updateNodeConfig(key, configAtajoMedio(medio));
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
        (b) =>
          !filtro ||
          tc(`${b.id}.label`).toLowerCase().includes(filtro) ||
          tc(`${b.id}.blurb`).toLowerCase().includes(filtro),
      ),
    [filtro, tc],
  );
  const listos = bloques.filter((b) => b.tipo);
  const proximos = bloques.filter((b) => !b.tipo);

  if (plegado) {
    return (
      <button
        type="button"
        onClick={() => setPlegado(false)}
        title={tc("expand")}
        aria-label={tc("expand")}
        className={cn(
          "pointer-events-auto flex h-10 w-10 items-center justify-center rounded-xl border border-sidebar-border bg-sidebar/90 text-muted-foreground shadow-lg backdrop-blur-md transition-colors hover:text-foreground",
          className,
        )}
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
    );
  }

  return (
    <aside
      className={cn(
        "pointer-events-auto flex w-[264px] flex-col overflow-hidden rounded-xl border border-sidebar-border bg-sidebar/90 shadow-[0_18px_48px_-18px_rgba(0,0,0,0.7)] backdrop-blur-md",
        className,
      )}
    >
      {/* ---- pestañas ---- */}
      <div className="flex items-center gap-1 border-b border-sidebar-border p-1.5">
        <div className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-background/50 p-0.5">
          {(
            [
              { id: "herramientas", icon: Wrench, label: tc("tabTools") },
              { id: "simular", icon: FlaskConical, label: tc("tabSimulate") },
            ] as const
          ).map((p) => {
            const activa = pestana === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={activa}
                onClick={() => setPestana(p.id)}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-semibold transition-colors",
                  activa
                    ? "bg-primary text-primary-foreground shadow-[0_4px_14px_-6px_var(--primary)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <p.icon className="h-3.5 w-3.5" />
                {p.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setPlegado(true)}
          title={tc("collapse")}
          aria-label={tc("collapse")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>

      {pestana === "simular" ? (
        <div className="relative min-h-0 flex-1">
          <FlowPreview onEdit={(key) => onEditarDesdeSimulacion?.(key)} />
        </div>
      ) : (
        <>
          {/* ---- buscador ---- */}
          <div className="border-b border-sidebar-border p-2">
            <label className="flex items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 px-2.5 py-1.5 focus-within:border-primary">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder={tc("search")}
                aria-label={tc("search")}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </label>
          </div>

          {/* ---- catálogo ---- */}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {listos.length > 0 && (
              <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {tc("available")}
              </p>
            )}
            {listos.map((b) => {
              const color = nodeColors(b.tipo!).solid;
              return (
                <div key={b.id}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => alArrastrar(e, { tipo: b.tipo! })}
                    onClick={() => agregar(b.tipo!)}
                    title={tc("dragHint")}
                    className="group flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent active:cursor-grabbing"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                      style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
                    >
                      <b.icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-foreground">
                        {tc(`${b.id}.label`)}
                      </span>
                      <span className="block truncate text-[10.5px] text-muted-foreground">
                        {tc(`${b.id}.blurb`)}
                      </span>
                    </span>
                  </button>
                  {b.id === "mensaje" && (
                    <div className="mb-1 ml-[42px] flex gap-1">
                      {ATAJOS_MEDIA.map((a) => (
                        <button
                          key={a.medio}
                          type="button"
                          draggable
                          onDragStart={(e) =>
                            alArrastrar(e, { tipo: "send_message", medio: a.medio })
                          }
                          onClick={() => agregar("send_message", a.medio)}
                          title={t(a.clave)}
                          aria-label={t(a.clave)}
                          className="flex h-6 w-6 cursor-grab items-center justify-center rounded-md border border-sidebar-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                        >
                          <a.icon className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {proximos.length > 0 && (
              <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {tc("comingSoon")}
              </p>
            )}
            {proximos.map((b) => (
              <div
                key={b.id}
                aria-disabled="true"
                title={tc("soonHint")}
                className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2 py-1.5 opacity-55"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{
                    background: `color-mix(in oklch, ${TONO[b.tono]} 14%, transparent)`,
                    color: TONO[b.tono],
                  }}
                >
                  <b.icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-muted-foreground">
                  {tc(`${b.id}.label`)}
                </span>
                <span className="rounded-full border border-sidebar-border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {tc("soon")}
                </span>
              </div>
            ))}

            {bloques.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                {tc("noResults")}
              </p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
