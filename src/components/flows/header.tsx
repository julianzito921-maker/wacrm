"use client";

/**
 * Barra del editor de flujos, igual a la de Leona (medida el 27-nov-2026):
 * flota sobre el lienzo (12 px de margen, 50 px de alto, #141127, borde
 * #251e45, radio 5.6).
 *   - Izquierda: ← volver · nombre (16.9 px, negrita) · ✎ editar nombre.
 *   - Derecha: botones de 26 px. «Guardar» va en morado (donde Leona pone
 *     su asistente), luego Pausar/Activar, Ejecuciones, avisos, conexión,
 *     vista y Archivar.
 *
 * Lee todo del contexto del editor (`useFlowEditor`), así sigue en
 * sincronía con cualquier vista que esté editando.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Archive, ArrowLeft, History, Loader2, Pause, Pencil, Play, Save } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useFlowEditor } from "./flow-editor-state";

const BOTON =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-3 text-[11.25px] font-medium text-slate-50 transition-colors hover:bg-[#2e2654] disabled:cursor-not-allowed disabled:opacity-50";

export function EditorHeader({
  viewSwitch,
  issues,
  className,
}: {
  viewSwitch?: ReactNode;
  /** Botón de avisos de validación (con contador). */
  issues?: ReactNode;
  className?: string;
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
  } = useFlowEditor();

  const activo = state.status === "active";
  const [conexiones, setConexiones] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState(flow.connection_id ?? "");
  const [editandoNombre, setEditandoNombre] = useState(false);
  const inputNombre = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editandoNombre) inputNombre.current?.select();
  }, [editandoNombre]);

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
    <header
      className={cn(
        "pointer-events-auto flex min-h-[50px] items-center gap-2 rounded-[5.6px] border border-[#251e45] bg-[#141127] px-[11px] py-[9px]",
        className,
      )}
    >
      {/* ---- izquierda ---- */}
      <button
        type="button"
        onClick={() => router.push("/flows")}
        title={t("backToFlows")}
        aria-label={t("backToFlows")}
        className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7.5px] text-slate-300 transition-colors hover:bg-[#241e42] hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      {editandoNombre ? (
        <input
          ref={inputNombre}
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          onBlur={() => setEditandoNombre(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditandoNombre(false);
          }}
          placeholder={t("namePlaceholder")}
          aria-label={t("namePlaceholder")}
          spellCheck={false}
          className="h-[30px] w-[320px] min-w-0 rounded-[7.5px] border border-[#8b5cf6] bg-transparent px-2 text-[16.9px] font-bold text-slate-50 outline-none"
        />
      ) : (
        <h1
          onDoubleClick={() => setEditandoNombre(true)}
          className="min-w-0 truncate rounded-[7.5px] px-1 text-[16.9px] leading-[30px] font-bold text-slate-50"
        >
          {state.name || t("namePlaceholder")}
        </h1>
      )}
      {!editandoNombre && (
        <button
          type="button"
          onClick={() => setEditandoNombre(true)}
          title={t("editName")}
          aria-label={t("editName")}
          className="inline-flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-[7.5px] text-slate-400 transition-colors hover:bg-[#241e42] hover:text-white"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {dirty && (
        <span
          className="hidden shrink-0 items-center gap-1.5 text-[10px] font-medium tracking-wide text-amber-300 uppercase md:inline-flex"
          title={t("unsavedHint")}
          aria-live="polite"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {t("edited")}
        </span>
      )}

      {/* ---- derecha ---- */}
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        <div className="hidden lg:block">{viewSwitch}</div>
        <select
          value={connectionId}
          onChange={(e) => void cambiarConexion(e.target.value)}
          className="hidden h-[26px] max-w-[170px] rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-2 text-[11.25px] text-slate-200 outline-none focus:border-[#8b5cf6] xl:block"
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
        {issues}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full bg-[#8b5cf6] px-3 text-[11.25px] font-medium text-white transition-colors hover:bg-[#7c3aed] disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t("save")}
        </button>
        <button
          type="button"
          onClick={() => void setStatus(activo ? "draft" : "active")}
          disabled={bloqueado}
          aria-label={activo ? t("pauseFlow") : t("activate")}
          title={!activo && !canActivate ? t("fixIssues") : activo ? t("pauseFlow") : t("activate")}
          className={BOTON}
        >
          {activating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : activo ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {activo ? t("pause") : t("activate")}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/flows/${flow.id}/runs`)}
          title={t("runs")}
          className={BOTON}
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">{t("runs")}</span>
          <span className="font-mono">{flow.execution_count}</span>
        </button>
        <button
          type="button"
          onClick={() => void setStatus("archived")}
          disabled={activating || state.status === "archived"}
          aria-label={t("archiveFlow")}
          title={t("archiveFlow")}
          className={BOTON}
        >
          <Archive className="h-3.5 w-3.5" />
          {t("archive")}
        </button>
      </div>
    </header>
  );
}
