"use client";

/**
 * Marco del editor de flujos (rediseño del 22-nov-2026).
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ barra de 56 px: volver · nombre · estado · vistas · Activar│
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ┌─panel flotante─┐                                         │
 *   │ │ Herramientas / │        lienzo (React Flow)              │
 *   │ │ Simular        │                                         │
 *   │ └────────────────┘ zoom ↙                      MiniMap ↘   │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Los avisos de validación ya no ocupan una franja abajo: van en un
 * botón con contador en la barra y como globo en cada nodo del lienzo.
 *
 * Tres vistas sobre los mismos datos: Lienzo, Lista y Vista previa (el
 * celular de prueba: se escribe como la clienta y se ve el embudo). El
 * panel flotante solo va sobre el lienzo; la Lista trae su propio
 * «Agregar nodo». En pantallas chicas el lienzo no se usa (los puntos de
 * conexión son muy pequeños para el dedo) y se abre la Lista.
 *
 * La vista elegida se recuerda en este navegador (localStorage).
 */

import { useEffect, useState } from "react";
import { GitFork, List, Maximize2, MessageSquare, Minimize2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { FlowBuilder } from "./flow-builder";
import { FlowCanvas } from "./flow-canvas";
import { FlowPalette } from "./flow-palette";
import { FlowSimulator } from "./flow-simulator";
import { FlowEditorProvider, useFlowEditor } from "./flow-editor-state";
import { EditorHeader } from "./header";
import { ValidationButton } from "./validation-panel";
import { PortalContainerProvider } from "@/components/ui/portal-container";
import { cn } from "@/lib/utils";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";

const MOBILE_BREAKPOINT = "(max-width: 767px)";

type View = "canvas" | "list" | "preview";

const STORAGE_KEY = "wacrm.flowEditor.view";

interface Props {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
}

export function FlowEditorShell({ initialFlow, initialNodes }: Props) {
  return (
    <FlowEditorProvider initialFlow={initialFlow} initialNodes={initialNodes}>
      <ShellBody />
    </FlowEditorProvider>
  );
}

function ShellBody() {
  const t = useTranslations("Flows.builder");
  const { requestFlash } = useFlowEditor();

  // Pantalla completa: los portales (paneles, menús) se montan dentro del
  // contenedor, porque fuera de él el navegador no pinta nada.
  const [contenedor, setContenedor] = useState<HTMLDivElement | null>(null);
  const [pantallaCompleta, setPantallaCompleta] = useState(false);

  useEffect(() => {
    const alCambiar = () => setPantallaCompleta(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", alCambiar);
    return () => document.removeEventListener("fullscreenchange", alCambiar);
  }, []);

  const alternarPantallaCompleta = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await contenedor?.requestFullscreen();
      }
    } catch {
      // Algún navegador puede negarse: el editor sigue en su tamaño normal.
    }
  };

  // El padre solo nos monta tras un fetch en el cliente: no hay SSR de
  // este árbol, así que leer localStorage aquí no causa desajustes.
  const [view, setView] = useState<View>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "canvas" || saved === "list" || saved === "preview") {
        return saved;
      }
    } catch {
      // Navegación privada / almacenamiento apagado.
    }
    return "canvas";
  });

  const isMobile = useMatchMedia(MOBILE_BREAKPOINT);
  const effectiveView: View = isMobile && view === "canvas" ? "list" : view;

  const choose = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignorar
    }
  };

  const editarDesdePreview = (key: string) => {
    choose("list");
    requestFlash(key);
  };

  // Desde la lista de avisos: en la vista previa no hay nodos que
  // señalar, así que se pasa al lienzo (o a la Lista en el celular).
  const irAlNodo = (key: string) => {
    if (effectiveView === "preview") choose(isMobile ? "list" : "canvas");
    requestFlash(key);
  };

  const cambioDeVista = (
    <div
      role="group"
      aria-label={t("editorView")}
      className="inline-flex h-[26px] items-center gap-0.5 rounded-[7.5px] border border-[#251e45] bg-[#1c1734] p-0.5"
    >
      {!isMobile && (
        <SegButton
          active={effectiveView === "canvas"}
          onClick={() => choose("canvas")}
          icon={<GitFork className="h-3 w-3" />}
          label={t("canvasView")}
        />
      )}
      <SegButton
        active={effectiveView === "list"}
        onClick={() => choose("list")}
        icon={<List className="h-3 w-3" />}
        label={t("listView")}
      />
      <SegButton
        active={effectiveView === "preview"}
        onClick={() => choose("preview")}
        icon={<MessageSquare className="h-3 w-3" />}
        label={t("previewView")}
      />
    </div>
  );

  const barra = (flotante: boolean) => (
    <EditorHeader
      className={flotante ? undefined : "rounded-none border-x-0 border-t-0"}
      viewSwitch={cambioDeVista}
      issues={<ValidationButton onJump={irAlNodo} />}
    />
  );

  return (
    <PortalContainerProvider value={pantallaCompleta ? contenedor : null}>
      <div
        ref={setContenedor}
        className="flex min-h-0 flex-1 flex-col bg-canvas"
      >
        {effectiveView !== "canvas" && barra(false)}

        {/* En móvil el cambio de vista no cabe en la barra: va aquí. */}
        <div className="flex justify-center border-b border-sidebar-border bg-sidebar px-3 py-2 lg:hidden">
          {cambioDeVista}
        </div>

        {/* ---- escenario: la vista activa ---- */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {effectiveView === "canvas" ? (
            <>
              <FlowCanvas />
              {/* Como Leona: la barra flota sobre el lienzo y debajo van
                  «Herramientas» y «Simular». `pointer-events-none` en los
                  contenedores para no tapar el lienzo. */}
              <div className="pointer-events-none absolute inset-x-3 top-3 z-20">
                {barra(true)}
              </div>
              <div className="pointer-events-none absolute top-[60px] bottom-3 left-3 z-10 flex flex-col">
                <FlowPalette
                  className="max-h-full min-h-0 flex-1"
                  onEditarDesdeSimulacion={editarDesdePreview}
                />
              </div>
              <button
                type="button"
                onClick={alternarPantallaCompleta}
                title={pantallaCompleta ? t("minimize") : t("maximize")}
                aria-label={pantallaCompleta ? t("minimize") : t("maximize")}
                className="absolute top-[60px] right-3 z-10 flex h-[34px] w-[34px] items-center justify-center rounded-[7.5px] border border-[#362c64] bg-[#161229] text-slate-300 transition-colors hover:text-white"
              >
                {pantallaCompleta ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            </>
          ) : effectiveView === "preview" ? (
            <FlowSimulator onEdit={editarDesdePreview} />
          ) : (
            <div className="absolute inset-0 overflow-y-auto bg-background">
              <FlowBuilder />
            </div>
          )}
        </div>
      </div>
    </PortalContainerProvider>
  );
}

/** `matchMedia` en vivo, sin dependencias. */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

function SegButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-[20px] items-center gap-1 rounded-[5.6px] px-2 text-[11.25px] font-medium transition-colors",
        active
          ? "bg-[#8b5cf6] text-white"
          : "text-slate-400 hover:text-white",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
