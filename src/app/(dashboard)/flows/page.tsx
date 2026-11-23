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
  HelpCircle,
  UserPlus,
  FileText,
  Upload,
  Download,
  Search,
  FolderOpen,
  LayoutList,
  LayoutGrid,
} from "lucide-react";

import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
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
import { Badge } from "@/components/ui/badge";
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
}

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

const STATUS_COLORS: Record<FlowRow["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-emerald-600/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  archived: "border-border bg-muted/50 text-muted-foreground",
};

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

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [vista, setVista] = useState<"lista" | "tarjetas">("lista");
  const [carpetas, setCarpetas] = useState(true);
  const [busqueda, setBusqueda] = useState("");
  const [abiertas, setAbiertas] = useState<Record<string, boolean>>({});
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
    if (!q) return flows;
    return flows.filter((f) => {
      const palabras = Array.isArray(f.trigger_config.keywords)
        ? (f.trigger_config.keywords as string[]).join(" ")
        : "";
      return `${f.name} ${f.description ?? ""} ${palabras}`.toLowerCase().includes(q);
    });
  }, [flows, busqueda]);

  const grupos = useMemo(() => {
    if (!carpetas) return [["", filtrados] as const];
    const mapa = new Map<string, FlowRow[]>();
    for (const f of filtrados) {
      const c = carpetaDe(f.name);
      mapa.set(c, [...(mapa.get(c) ?? []), f]);
    }
    return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtrados, carpetas]);

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

  /**
   * Un flujo se ARCHIVA; solo se borra de verdad si ya estaba archivado.
   *
   * Por qué: el borrado es irreversible y se lleva sus pasos en cascada.
   * Perder un embudo entero por un clic (con el constructor abierto y sin
   * papelera) es un precio demasiado alto: archivado desaparece del camino
   * vivo y se puede recuperar.
   */
  async function handleDelete(flow: FlowRow) {
    const yaArchivado = flow.status === "archived";
    const yes = window.confirm(
      yaArchivado
        ? t("deleteConfirm", { name: flow.name })
        : t("archiveConfirm", { name: flow.name }),
    );
    if (!yes) return;
    try {
      if (yaArchivado) {
        const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        setFlows((prev) => prev.filter((f) => f.id !== flow.id));
        toast.success(t("deleteSuccess"));
      } else {
        const res = await fetch(`/api/flows/${flow.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "archived" }),
        });
        if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
        setFlows((prev) =>
          prev.map((f) => (f.id === flow.id ? { ...f, status: "archived" } : f)),
        );
        toast.success(t("archiveSuccess"));
      }
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

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
              {t("beta")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </header>

      {/* ---- barra de herramientas ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder={t("search")}
            className="h-9 w-64 bg-muted pl-8"
          />
        </div>

        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createFlows")}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("newFlow")}
        </GatedButton>

        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createFlows")}
          variant="outline"
          onClick={() => archivoRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          {t("importFlow")}
        </GatedButton>
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

        <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5">
          <ToolButton
            active={carpetas}
            onClick={() => setCarpetas((v) => !v)}
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            label={t("folders")}
          />
          <ToolButton
            active={vista === "lista"}
            onClick={() => setVista("lista")}
            icon={<LayoutList className="h-3.5 w-3.5" />}
            label={t("listView")}
          />
          <ToolButton
            active={vista === "tarjetas"}
            onClick={() => setVista("tarjetas")}
            icon={<LayoutGrid className="h-3.5 w-3.5" />}
            label={t("cardView")}
          />
        </div>
      </div>

      {flows.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} t={t} />
      ) : filtrados.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
          {t("noResults")}
        </p>
      ) : vista === "tarjetas" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtrados.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/flows/${flow.id}`)}
              onExport={() => void handleExport(flow)}
              onDelete={() => void handleDelete(flow)}
              t={t}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {grupos.map(([grupo, lista]) => {
            const abierto = abiertas[grupo] !== false;
            const clave = grupo || "general";
            return (
              <section key={clave} className="overflow-hidden rounded-lg border border-border bg-card">
                {carpetas && (
                  <button
                    type="button"
                    onClick={() => setAbiertas((prev) => ({ ...prev, [grupo]: !abierto }))}
                    className="flex w-full items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-left"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[12.5px] font-semibold text-foreground">
                      {grupo || t("folderGeneral")}
                    </span>
                    <span className="text-[11.5px] text-muted-foreground">{lista.length}</span>
                  </button>
                )}
                {abierto && (
                  <div className="divide-y divide-border">
                    {lista.map((flow) => {
                      const StatusIcon =
                        flow.status === "active"
                          ? PlayCircle
                          : flow.status === "archived"
                            ? Archive
                            : PauseCircle;
                      return (
                        <div
                          key={flow.id}
                          className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,2fr)_auto_auto_auto_auto]"
                        >
                          <button
                            type="button"
                            onClick={() => router.push(`/flows/${flow.id}`)}
                            className="flex min-w-0 items-center gap-2 text-left"
                          >
                            <Workflow className="h-4 w-4 shrink-0 text-primary" />
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-semibold text-foreground">
                                {flow.name}
                              </span>
                              <span className="block truncate text-[11.5px] text-muted-foreground">
                                {flow.description || describeTrigger(flow, t)}
                              </span>
                            </span>
                          </button>

                          <Badge
                            variant="outline"
                            className={cn("hidden shrink-0 gap-1 text-[10px] md:inline-flex", STATUS_COLORS[flow.status])}
                          >
                            <StatusIcon className="h-3 w-3" />
                            {statusLabels[flow.status]}
                          </Badge>

                          <span className="hidden items-center gap-1 text-[11.5px] text-muted-foreground md:inline-flex">
                            <MessageSquare className="h-3 w-3" />
                            {t("runCount", { count: flow.execution_count })}
                          </span>

                          <span className="hidden text-[11.5px] text-muted-foreground md:block">
                            {new Date(flow.updated_at).toLocaleDateString()}
                          </span>

                          <span className="flex shrink-0 items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => router.push(`/flows/${flow.id}`)}>
                              <Pencil className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">{t("edit")}</span>
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => void handleExport(flow)}>
                              <Download className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">{t("export")}</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleDelete(flow)}
                              title={flow.status === "archived" ? t("delete") : t("archive")}
                              className="text-red-500 hover:bg-red-500/10 dark:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
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
    </div>
  );
}

function ToolButton({
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
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
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

function FlowCard({
  flow,
  onEdit,
  onExport,
  onDelete,
  t,
}: {
  flow: FlowRow;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const triggerSummary = describeTrigger(flow, t);
  const StatusIcon =
    flow.status === "active" ? PlayCircle : flow.status === "archived" ? Archive : PauseCircle;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">{flow.name}</h3>
        </div>
        <Badge variant="outline" className={cn("shrink-0 gap-1 text-[10px]", STATUS_COLORS[flow.status])}>
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {flow.description || triggerSummary}
      </p>

      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {t("runCount", { count: flow.execution_count })}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t("edit")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          {t("export")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-500 hover:bg-red-500/10 dark:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("delete")}
        </Button>
      </div>
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
