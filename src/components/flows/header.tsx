"use client";

/**
 * Barra superior del editor de flujos (rediseño del 22-nov-2026): una
 * sola fila de 56 px.
 *   - Izquierda: volver · ícono · nombre editable · estado · «Editado».
 *   - Centro: el cambio de vista (Lienzo / Lista / Vista previa), que
 *     llega desde FlowEditorShell porque es quien guarda la vista.
 *   - Derecha: Ejecuciones · Eliminar · Guardar · interruptor «Activar».
 *
 * La descripción del flujo se edita ahora en la vista Lista.
 *
 * Lee todo del contexto del editor (`useFlowEditor`), así sigue en
 * sincronía con cualquier vista que esté editando.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  History,
  Loader2,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useFlowEditor, type BuilderState } from "./flow-editor-state";

export function EditorHeader({
  viewSwitch,
  issues,
}: {
  viewSwitch?: ReactNode;
  /** Botón de avisos de validación (con contador). */
  issues?: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("Flows.header");
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
  } = useFlowEditor();

  const activo = state.status === "active";
  const [conexiones, setConexiones] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState(flow.connection_id ?? "");

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("whatsapp_connections")
        .select("id, name")
        .eq("active", true)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      if (!cancelado) setConexiones((data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const cambiarConexion = async (valor: string) => {
    setConnectionId(valor);
    try {
      const res = await fetch(`/api/flows/${flow.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection_id: valor || null }),
      });
      if (!res.ok) throw new Error();
      toast.success(t("connectionUpdated"));
    } catch {
      setConnectionId(flow.connection_id ?? "");
      toast.error(t("connectionUpdateFailed"));
    }
  };
  // Para activar hay que pasar la validación; pausar siempre se puede.
  const bloqueado = activating || (!activo && !canActivate);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-3 sm:px-4">
      {/* ---- izquierda ---- */}
      <button
        type="button"
        onClick={() => router.push("/flows")}
        title={t("backToFlows")}
        aria-label={t("backToFlows")}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary sm:flex">
        <Workflow className="h-4 w-4" />
      </span>
      <input
        value={state.name}
        onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
        placeholder={t("namePlaceholder")}
        spellCheck={false}
        aria-label={t("namePlaceholder")}
        className="w-[120px] min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold text-foreground outline-none transition-colors hover:bg-sidebar-accent focus:border-primary focus:bg-transparent sm:w-[240px]"
      />
      <StatusBadge status={state.status} />
      {dirty && (
        <span
          className="hidden shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-300 md:inline-flex"
          title={t("unsavedHint")}
          aria-live="polite"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {t("edited")}
        </span>
      )}

      {/* ---- centro ---- */}
      <select
        value={connectionId}
        onChange={(e) => void cambiarConexion(e.target.value)}
        className="hidden h-8 max-w-[220px] rounded-md border border-sidebar-border bg-card px-2 text-[11px] text-muted-foreground outline-none focus:border-primary md:block"
        aria-label={t("listenConnection")}
        title={t("listenConnection")}
      >
        <option value="">{t("listenAll")}</option>
        {conexiones.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="mx-auto hidden md:block">{viewSwitch}</div>

      {/* ---- derecha ---- */}
      <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
        {issues}
        <button
          type="button"
          onClick={() => router.push(`/flows/${flow.id}/runs`)}
          title={t("runs")}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">{t("runs")}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {flow.execution_count}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void deleteFlow()}
          title={t("delete")}
          aria-label={t("delete")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sidebar-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/50 disabled:opacity-60"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t("save")}
        </button>

        <div className="mx-1 h-6 w-px bg-sidebar-border" />

        {/* Interruptor morado: activo ↔ borrador. */}
        <button
          type="button"
          role="switch"
          aria-checked={activo}
          aria-label={t("activate")}
          onClick={() => void setStatus(activo ? "draft" : "active")}
          disabled={bloqueado}
          title={!activo && !canActivate ? t("fixIssues") : activo ? t("pause") : t("activate")}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed",
            activo ? "text-foreground" : "text-muted-foreground",
            !bloqueado && "hover:bg-sidebar-accent",
            bloqueado && !activating && "opacity-50",
          )}
        >
          {t("activate")}
          <span
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              activo ? "bg-primary shadow-[0_0_12px_-2px_var(--primary)]" : "bg-muted ring-1 ring-sidebar-border",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform",
                activo ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            >
              {activating && <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />}
            </span>
          </span>
        </button>
      </div>
    </header>
  );
}

function StatusBadge({ status }: { status: BuilderState["status"] }) {
  // Las etiquetas de estado salen de la lista de flujos: así nunca se
  // desalinean la tarjeta y la barra.
  const t = useTranslations("Flows.list");
  const cfg = {
    draft: {
      cls: "border-sidebar-border bg-muted text-muted-foreground",
      dot: "bg-muted-foreground",
      label: t("statusDraft"),
    },
    active: {
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      dot: "bg-emerald-400",
      label: t("statusActive"),
    },
    archived: {
      cls: "border-sidebar-border bg-muted/50 text-muted-foreground",
      dot: "bg-muted-foreground/60",
      label: t("statusArchived"),
    },
  }[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        cfg.cls,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}
