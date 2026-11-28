"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  ArchiveRestore,
  HelpCircle,
  UserPlus,
  FileText,
  Upload,
  Download,
  Search,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FileArchive,
  Boxes,
  MoreVertical,
} from "lucide-react";

import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { ImportChatDialog } from "@/components/flows/import-chat-dialog";
import { ImportarLeonaDialog } from "@/components/flows/importar-leona-dialog";
import { esFlujoLeona } from "@/lib/flows/leona/convertir";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Flows list page.
 *
 * Defaults to a LIST of rows — one line per flow with name, status,
 * trigger, runs and updated date — because that's what makes a pile of
 * flows comparable at a glance. A card view stays one click away.
 *
 * «Carpetas» groups flows by the prefix of their name («Glúteos · …»,
 * «Amigurumis · …»). It's derived from the name, not stored: no schema
 * change, and a flow moves folders just by renaming it.
 *
 * Import/export round-trips a flow as JSON so a funnel built in one
 * place can be dropped into another account as a fresh draft.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "any_message" | "manual";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Bloques del flujo (columna BLOQUES). */
  node_count?: number;
}

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

/** Carpeta de un flujo = lo que va antes del «·» en su nombre. */
function carpetaDe(nombre: string): string {
  const i = nombre.indexOf("·");
  return i > 0 ? nombre.slice(0, i).trim() : "";
}

/** Nombre sin la carpeta. */
function nombreSinCarpeta(nombre: string): string {
  const i = nombre.indexOf("·");
  return i > 0 ? nombre.slice(i + 1).trim() : nombre;
}

type Filtro = "todos" | "activos" | "pausados" | "archivados";

/** Carpetas creadas a mano que aún no tienen flujos (se guardan en el navegador). */
const CLAVE_CARPETAS = "wacrm.flows.carpetas";

/** Color de cada estado, como en Leona: verde activo, ámbar pausado. */
const ESTADO_COLOR: Record<FlowRow["status"], string> = {
  active: "#10b981",
  draft: "#f59e0b",
  archived: "#64748b",
};

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [importChatOpen, setImportChatOpen] = useState(false);
  const [importLeonaOpen, setImportLeonaOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [carpetaActual, setCarpetaActual] = useState("");
  const [carpetasManuales, setCarpetasManuales] = useState<string[]>([]);
  useEffect(() => {
    try {
      const crudo = window.localStorage.getItem(CLAVE_CARPETAS);
      if (crudo) setCarpetasManuales(JSON.parse(crudo) as string[]);
    } catch {
      // almacenamiento apagado
    }
  }, []);
  const [menuAbierto, setMenuAbierto] = useState<string | null>(null);
  const archivoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/flows"),
          fetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return flows.filter((f) => {
      if (filtro === "activos" && f.status !== "active") return false;
      if (filtro === "pausados" && f.status !== "draft") return false;
      if (filtro === "archivados" && f.status !== "archived") return false;
      if (filtro === "todos" && f.status === "archived") return false;
      if (!q) return true;
      const palabras = Array.isArray(f.trigger_config.keywords)
        ? (f.trigger_config.keywords as string[]).join(" ")
        : "";
      return `${f.name} ${f.description ?? ""} ${palabras}`.toLowerCase().includes(q);
    });
  }, [flows, busqueda, filtro]);

  /** Carpetas: las del nombre de los flujos + las creadas a mano. */
  const listaCarpetas = useMemo(() => {
    const set = new Set<string>(carpetasManuales);
    for (const f of flows) {
      const c = carpetaDe(f.name);
      if (c) set.add(c);
    }
    return ["", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [flows, carpetasManuales]);

  const visibles = useMemo(
    () => filtrados.filter((f) => carpetaDe(f.name) === carpetaActual),
    [filtrados, carpetaActual],
  );

  function guardarCarpetas(lista: string[]) {
    setCarpetasManuales(lista);
    try {
      window.localStorage.setItem(CLAVE_CARPETAS, JSON.stringify(lista));
    } catch {
      // almacenamiento apagado: la carpeta vive mientras la página esté abierta
    }
  }

  function nuevaCarpeta() {
    const nombre = window.prompt(t("folderPrompt"))?.trim().replace(/·/g, "");
    if (!nombre) return;
    if (!carpetasManuales.includes(nombre)) guardarCarpetas([...carpetasManuales, nombre]);
    setCarpetaActual(nombre);
  }

  /** Mover = renombrar con el prefijo «Carpeta · ». */
  async function moverACarpeta(flow: FlowRow) {
    setMenuAbierto(null);
    const destino = window.prompt(t("movePrompt"), carpetaDe(flow.name))?.trim().replace(/·/g, "");
    if (destino === undefined || destino === null) return;
    const base = nombreSinCarpeta(flow.name);
    const nuevo = destino ? `${destino} · ${base}` : base;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nuevo }),
      });
      if (!res.ok) throw new Error(`Move failed: ${res.status}`);
      setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, name: nuevo } : f)));
      if (destino && !carpetasManuales.includes(destino)) {
        guardarCarpetas([...carpetasManuales, destino]);
      }
      toast.success(t("moveSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("moveError"));
    }
  }

  async function cambiarEstado(flow: FlowRow, status: FlowRow["status"]) {
    setMenuAbierto(null);
    try {
      const res = await fetch(`/api/flows/${flow.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Status failed: ${res.status}`);
      }
      setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, status } : f)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteError"));
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  /** Archivar: deja de responder pero se puede restaurar. */
  async function handleArchive(flow: FlowRow) {
    if (!window.confirm(t("archiveConfirm", { name: flow.name }))) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
      setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, status: "archived" } : f)));
      toast.success(t("archiveSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("archiveError"));
    }
  }

  /** Eliminar: borra el flujo y sus pasos para siempre (pide confirmación). */
  async function handleDelete(flow: FlowRow) {
    if (!window.confirm(t("deleteConfirm", { name: flow.name }))) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t("deleteSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    }
  }

  /** Descarga el flujo (con sus nodos) como JSON para poder importarlo. */
  async function handleExport(flow: FlowRow) {
    try {
      const res = await fetch(`/api/flows/${flow.id}`);
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const json = (await res.json()) as {
        flow: FlowRow & { entry_node_id?: string | null };
        nodes: Array<Record<string, unknown>>;
      };
      const salida = {
        flow: {
          name: json.flow.name,
          description: json.flow.description,
          trigger_type: json.flow.trigger_type,
          trigger_config: json.flow.trigger_config,
          entry_node_id: json.flow.entry_node_id ?? "start",
        },
        nodes: (json.nodes ?? []).map((n) => ({
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
          position_x: n.position_x,
          position_y: n.position_y,
        })),
      };
      const blob = new Blob([JSON.stringify(salida, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${flow.name.replace(/[^\w\-. ]+/g, "")}.flujo.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error(t("exportError"));
    }
  }

  async function handleImport(file: File) {
    try {
      const texto = await file.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(texto) as Record<string, unknown>;
      } catch {
        toast.error(t("importInvalid"));
        return;
      }
      // Un flujo de Leona (su JSON con actions/connections) se traduce
      // en el servidor a bloques del WaCRM.
      if (esFlujoLeona(json)) {
        const res = await fetch("/api/flows/import-leona", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leona_json: json }),
        });
        const r = (await res.json().catch(() => ({}))) as {
          created?: Array<{ id: string; avisos: string[] }>;
          error?: string;
        };
        if (!res.ok || !r.created?.length) throw new Error(r.error ?? t("importError"));
        toast.success(t("importSuccess"));
        if (r.created[0].avisos.length) toast.message(r.created[0].avisos.slice(0, 3).join(" · "));
        router.push(`/flows/${r.created[0].id}`);
        return;
      }
      // Acepta tanto { flow, nodes } (lo que exportamos) como un flujo
      // suelto { name, nodes }.
      const import_flow =
        json.flow && typeof json.flow === "object"
          ? { ...(json.flow as Record<string, unknown>), nodes: json.nodes }
          : json;
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import_flow }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Import failed: ${res.status}`);
      }
      const creado = (await res.json()) as { flow: FlowRow };
      setFlows((prev) => [creado.flow, ...prev]);
      toast.success(t("importSuccess"));
      router.push(`/flows/${creado.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : t("importError"));
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const statusLabels = STATUS_LABELS(t);
  const botonOscuro =
    "inline-flex h-[38px] items-center gap-2 rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-4 text-[13px] font-medium text-slate-50 transition-colors hover:bg-[#2e2654]";
  const filtros: { id: Filtro; label: string; color?: string }[] = [
    { id: "todos", label: t("filterAll") },
    { id: "activos", label: t("filterActive"), color: ESTADO_COLOR.active },
    { id: "pausados", label: t("filterPaused"), color: ESTADO_COLOR.draft },
    { id: "archivados", label: t("filterArchived"), color: ESTADO_COLOR.archived },
  ];

  return (
    <div className="space-y-[15px] p-6" onClick={() => setMenuAbierto(null)}>
      {/* ---- encabezado ---- */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[7.5px] bg-[#241e42] text-[#8b5cf6]">
            <Workflow className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h1 className="text-[18.75px] leading-snug font-bold text-slate-50">{t("title")}</h1>
            <p className="text-[13px] text-slate-400">{t("description")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            canAct={canCreate}
            gateReason={tGate("reasons.createFlows")}
            onClick={() => setCreateOpen(true)}
            className="h-[38px] rounded-[7.5px] bg-[#8b5cf6] px-5 text-[13px] font-medium text-white shadow-[0_6px_18px_-8px_#8b5cf6] hover:bg-[#7c3aed]"
          >
            <Plus className="h-4 w-4" />
            {t("newFlow")}
          </GatedButton>
          <button type="button" onClick={nuevaCarpeta} className={botonOscuro}>
            <FolderPlus className="h-4 w-4" />
            {t("folder")}
          </button>
          <button
            type="button"
            onClick={() => setImportLeonaOpen(true)}
            disabled={!canCreate}
            className={botonOscuro}
          >
            <Upload className="h-4 w-4" />
            {t("importFlow")}
          </button>
          <button
            type="button"
            onClick={() => setImportChatOpen(true)}
            disabled={!canCreate}
            className={botonOscuro}
          >
            <FileArchive className="h-4 w-4" />
            {t("importChat")}
          </button>
          <input
            ref={archivoRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {/* ---- buscador y filtros ---- */}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder={t("search")}
          className="h-[38px] w-full rounded-[5.6px] border border-[#251e45] bg-[#1c1734] pr-3 pl-9 text-[13px] font-medium text-slate-50 outline-none transition-colors placeholder:text-slate-500 hover:border-[#362c64] focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/30"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {filtros.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFiltro(f.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[7.5px] border px-3 text-[11.25px] font-semibold transition-colors",
              filtro === f.id
                ? "border-[#8b5cf6] bg-[#8b5cf6] text-white"
                : "border-[#251e45] bg-[#1c1734] text-slate-300 hover:text-white",
            )}
          >
            {f.color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: f.color }} />}
            {f.label}
          </button>
        ))}
      </div>

      {flows.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} t={t} />
      ) : (
        <div className="flex min-h-[420px] overflow-hidden rounded-[5.6px] border border-[#251e45] bg-[#1c1734]">
          {/* ---- carpetas ---- */}
          <aside className="hidden w-[239px] shrink-0 border-r border-[#251e45] md:block">
            <div className="px-[11px] py-[9px] text-[10px] font-semibold tracking-[0.25px] text-slate-400 uppercase">
              {t("folders")}
            </div>
            <nav className="space-y-0.5 px-[5.6px] pb-[11px]">
              {listaCarpetas.map((c) => {
                const activa = c === carpetaActual;
                const cuenta = filtrados.filter((f) => carpetaDe(f.name) === c).length;
                return (
                  <button
                    key={c || "sin-carpeta"}
                    type="button"
                    onClick={() => setCarpetaActual(c)}
                    className={cn(
                      "flex h-[30px] w-full items-center gap-2 rounded-[5.6px] px-[5.6px] text-left text-[13px] font-medium transition-colors",
                      activa ? "bg-[#8b5cf6] text-white" : "text-slate-200 hover:bg-[#241e42]",
                    )}
                  >
                    {c ? <Folder className="h-4 w-4 shrink-0" /> : <FolderOpen className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{c || t("noFolder")}</span>
                    <span className={cn("text-[11px]", activa ? "text-white/80" : "text-slate-500")}>{cuenta}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* ---- tabla ---- */}
          <section className="min-w-0 flex-1">
            <div className="border-b border-[#251e45] px-[11px] py-[7.5px]">
              <p className="text-[13px] font-medium text-slate-50">{carpetaActual || t("noFolder")}</p>
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_110px_90px_150px_40px] items-center border-b border-[#251e45] py-[7.5px] pr-[11px] pl-[26px] text-[10px] font-semibold tracking-[0.25px] text-slate-400 uppercase md:grid">
              <span>{t("colName")}</span>
              <span>{t("colStatus")}</span>
              <span>{t("colBlocks")}</span>
              <span>{t("colUpdated")}</span>
              <span />
            </div>
            {visibles.length === 0 ? (
              <p className="px-6 py-12 text-center text-[13px] text-slate-400">{t("noResults")}</p>
            ) : (
              visibles.map((flow) => {
                const color = ESTADO_COLOR[flow.status];
                return (
                  <div
                    key={flow.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/flows/${flow.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/flows/${flow.id}`);
                    }}
                    className="relative grid h-[50px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center border-b border-white/10 pr-[11px] pl-[26px] transition-colors hover:bg-[#241e42]/60 md:grid-cols-[minmax(0,1fr)_110px_90px_150px_40px]"
                  >
                    <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: color }} />
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: color }} />
                      <h3 className="truncate text-[13px] font-semibold text-slate-50" title={flow.description || describeTrigger(flow, t)}>
                        {nombreSinCarpeta(flow.name)}
                      </h3>
                    </span>
                    <span className="hidden md:block">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-[3.75px] border px-[7.5px] py-[2px] text-[11px] font-semibold uppercase"
                        style={{
                          background: `color-mix(in srgb, ${color} 10%, transparent)`,
                          borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
                          color: `color-mix(in srgb, ${color} 70%, #fff)`,
                        }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                        {statusLabels[flow.status]}
                      </span>
                    </span>
                    <span className="hidden items-center gap-1.5 text-[11.25px] text-slate-300 md:inline-flex">
                      <Boxes className="h-3.5 w-3.5 text-[#8b5cf6]" />
                      {flow.node_count ?? 0}
                    </span>
                    <time className="hidden text-[11.25px] text-slate-300 md:block">
                      {new Date(flow.updated_at).toLocaleString(undefined, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </time>
                    <span className="relative flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        aria-label={t("actions")}
                        onClick={() => setMenuAbierto((m) => (m === flow.id ? null : flow.id))}
                        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7.5px] text-slate-300 transition-colors hover:bg-[#241e42] hover:text-white"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {menuAbierto === flow.id && (
                        <div className="absolute top-8 right-0 z-30 w-48 overflow-hidden rounded-[7.5px] border border-[#362c64] bg-[#161229] py-1 shadow-xl">
                          <MenuItem icon={Pencil} label={t("edit")} onClick={() => router.push(`/flows/${flow.id}`)} />
                          {flow.status === "active" ? (
                            <MenuItem icon={PauseCircle} label={t("pause")} onClick={() => void cambiarEstado(flow, "draft")} />
                          ) : (
                            <MenuItem icon={PlayCircle} label={t("activate")} onClick={() => router.push(`/flows/${flow.id}`)} />
                          )}
                          <MenuItem icon={FolderInput} label={t("moveToFolder")} onClick={() => void moverACarpeta(flow)} />
                          <MenuItem icon={Download} label={t("export")} onClick={() => { setMenuAbierto(null); void handleExport(flow); }} />
                          {flow.status === "archived" && (
                            <MenuItem icon={ArchiveRestore} label={t("restore")} onClick={() => void cambiarEstado(flow, "draft")} />
                          )}
                          {flow.status !== "archived" && (
                            <MenuItem
                              icon={Archive}
                              label={t("archive")}
                              onClick={() => { setMenuAbierto(null); void handleArchive(flow); }}
                            />
                          )}
                          <MenuItem
                            icon={Trash2}
                            danger
                            label={t("delete")}
                            onClick={() => { setMenuAbierto(null); void handleDelete(flow); }}
                          />
                        </div>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("createDesc")}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("startTemplate")}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-50"
                    >
                      <Icon className="h-5 w-5 text-primary" />
                      <span className="text-sm font-semibold text-popover-foreground">
                        {template.name}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {template.description}
                      </span>
                      <span className="mt-auto border-t border-border pt-2 text-[11px] text-muted-foreground">
                        {t("nodeCount", { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("startBlank")}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("placeholderName")}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("createBlank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportChatDialog open={importChatOpen} onOpenChange={setImportChatOpen} />
      <ImportarLeonaDialog
        open={importLeonaOpen}
        onOpenChange={setImportLeonaOpen}
        onImportado={(id) => router.push(`/flows/${id}`)}
        onArchivo={() => {
          setImportLeonaOpen(false);
          archivoRef.current?.click();
        }}
      />
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[#241e42]",
        danger ? "text-red-400" : "text-slate-200",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Workflow className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">{t("emptyTitle")}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDesc")}</p>
      <GatedButton
        canAct={canCreate}
        gateReason={tGate("reasons.createFlows")}
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t("createFirst")}
      </GatedButton>
    </div>
  );
}

function describeTrigger(flow: FlowRow, t: ReturnType<typeof useTranslations>): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t("triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (flow.trigger_type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  return t("triggerManual");
}
