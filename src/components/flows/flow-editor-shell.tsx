"use client";

/**
 * View-switcher + chrome for the flow editor.
 *
 * Three views over the same data:
 *   - Canvas: the node graph (drag, connect, minimap).
 *   - List: the step-by-step editor with per-node forms.
 *   - Preview: the flow as the customer sees it on WhatsApp — image
 *     with its caption, texts, buttons and tags, in order, each step
 *     with an «Editar» button that jumps to that node in List view.
 *
 * The preview is the «read it like a customer» view: it answers
 * «¿qué le llega a la clienta?» without opening every node. It is
 * read-only (its Edit buttons switch to List and flash the node), so
 * it's also safe on a phone.
 *
 * View choice persists per-browser via localStorage.
 */

import { useEffect, useState } from "react";
import { GitFork, List, Maximize2, MessageSquare, Minimize2 } from "lucide-react";

import { FlowBuilder } from "./flow-builder";
import { FlowCanvas } from "./flow-canvas";
import { FlowPalette } from "./flow-palette";
import { FlowPreview } from "./flow-preview";
import { FlowEditorProvider, useFlowEditor } from "./flow-editor-state";
import { EditorHeader } from "./header";
import { ValidationPanel } from "./validation-panel";
import { NODE_META, nodeColors, type NodeType } from "./shared";
import { PortalContainerProvider } from "@/components/ui/portal-container";
import { cn } from "@/lib/utils";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";
import { useTranslations } from "next-intl";

/**
 * Below this viewport width the canvas is unusable (handles are ~10px
 * and finger drags between nodes aren't a practical workflow), so we
 * fall back to List. Preview stays available — it's read-only.
 */
const MOBILE_BREAKPOINT = "(max-width: 767px)";

type View = "canvas" | "list" | "preview";

const STORAGE_KEY = "wacrm.flowEditor.view";

// Legend covers every node type, derived from NODE_META so a new type
// can't silently go undocumented. NODE_META's key order already reads
// the way a flow flows: start → talk → capture → branch → mutate → end.
const LEGEND_TYPES = Object.keys(NODE_META) as NodeType[];

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

/**
 * Inside the provider so it can call `requestFlash` — the preview's
 * «Editar» buttons switch to List and flash the node that was clicked.
 */
function ShellBody() {
  const t = useTranslations("Flows.builder");
  const { requestFlash } = useFlowEditor();

  // Pantalla completa: el editor ocupa toda la ventana (el navegador
  // esconde la barra lateral y la cabecera), que es lo que hacía falta
  // para ver el flujo entero sin recortarlo.
  // En estado y no en un ref: durante el render hay que leerlo para
  // decidir dónde se montan los portales, y los refs no se leen ahí.
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
      // Algún navegador puede negarse (permisos); se ignora y el
      // editor sigue funcionando en su tamaño normal.
    }
  };

  // Read the persisted choice in the useState initializer. Safe even
  // though this is a client component because the parent page only
  // mounts us AFTER a client-side fetch resolves — there's no SSR
  // pass for this subtree, so no hydration mismatch to worry about.
  const [view, setView] = useState<View>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "canvas" || saved === "list" || saved === "preview") {
        return saved;
      }
    } catch {
      // Private browsing / disabled storage — fall through to default.
    }
    return "canvas";
  });

  // Live mobile detection. We don't render the canvas under the
  // breakpoint regardless of `view` — but we keep `view` itself
  // intact so the user's preference comes back when they widen again.
  const isMobile = useMatchMedia(MOBILE_BREAKPOINT);
  const effectiveView: View = isMobile && view === "canvas" ? "list" : view;

  const choose = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const editarDesdePreview = (key: string) => {
    choose("list");
    requestFlash(key);
  };

  return (
    // En pantalla completa, los paneles y menús se montan DENTRO del
    // contenedor a pantalla completa: fuera de él el navegador no pinta
    // nada, y era el motivo de que el editor del nodo no apareciera.
    <PortalContainerProvider value={pantallaCompleta ? contenedor : null}>
    <div
      ref={setContenedor}
      className={cn(
        // Sangrado negativo: el editor se come el relleno del panel y
        // usa todo el ancho y todo el alto disponibles en vez de quedar
        // como una tarjeta encajada dentro.
        "flex min-h-0 flex-col -mx-4 -my-4 h-[calc(100%+2rem)] sm:-mx-6 sm:-my-6 sm:h-[calc(100%+3rem)]",
        // En pantalla completa el navegador nos da la ventana entera y
        // ya no se hereda el fondo del panel.
        pantallaCompleta && "bg-background",
      )}
    >
      <EditorHeader />

      {/* ---- mode row: view toggle + node-type legend ----
          The legend is lg-only, so there's no empty band on small
          screens. */}
      <div className="flex items-center gap-4 px-6 py-3.5">
        <div
          role="group"
          aria-label={t("editorView")}
          className="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5"
        >
          {!isMobile && (
            <SegButton
              active={effectiveView === "canvas"}
              onClick={() => choose("canvas")}
              icon={<GitFork className="h-3.5 w-3.5" />}
              label={t("canvasView")}
            />
          )}
          <SegButton
            active={effectiveView === "list"}
            onClick={() => choose("list")}
            icon={<List className="h-3.5 w-3.5" />}
            label={t("listView")}
          />
          <SegButton
            active={effectiveView === "preview"}
            onClick={() => choose("preview")}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label={t("previewView")}
          />
        </div>
        <button
          type="button"
          onClick={alternarPantallaCompleta}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground lg:ml-0 lg:order-last"
        >
          {pantallaCompleta ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
          {pantallaCompleta ? t("minimize") : t("maximize")}
        </button>
        <div className="ml-auto hidden flex-wrap items-center gap-x-3.5 gap-y-1.5 lg:flex">
          {LEGEND_TYPES.map((tipo) => (
            <span
              key={tipo}
              className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: nodeColors(tipo).solid }}
              />
              {t(`nodes.${tipo}.label`)}
            </span>
          ))}
        </div>
      </div>

      {/* ---- cuerpo: barra de herramientas a la izquierda + vista ---- */}
      <div className="mx-6 flex min-h-0 flex-1 gap-4">
        <FlowPalette className="hidden w-[190px] shrink-0 md:flex" />

        {/* ---- stage: the active view, owning its own overflow ---- */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card-2">
          {effectiveView === "canvas" ? (
            <FlowCanvas />
          ) : effectiveView === "preview" ? (
            <FlowPreview onEdit={editarDesdePreview} />
          ) : (
            <div className="absolute inset-0 overflow-y-auto">
              <FlowBuilder />
            </div>
          )}
        </div>
      </div>

      {/* ---- validation / activate-readiness bar ---- */}
      <div className="px-6 pb-5 pt-3">
        <ValidationPanel />
      </div>
    </div>
    </PortalContainerProvider>
  );
}

/**
 * Tiny `useMatchMedia` shim. We could pull in `react-responsive` but
 * this is the only consumer and matchMedia is one of those browser
 * APIs that doesn't need a dependency.
 */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Safari < 14 still uses addListener; addEventListener is the
    // modern path. Both fire identically.
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
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
