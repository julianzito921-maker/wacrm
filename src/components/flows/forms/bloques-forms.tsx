"use client";

/**
 * Formularios de los bloques de la migración 079:
 *   - Botón Pago / SPEI (send_payment)
 *   - Template WhatsApp (send_template)
 *   - Kanban (move_kanban)
 *
 * Leen los catálogos de la cuenta (plantillas, embudos, etapas) con el
 * cliente de Supabase del navegador: RLS ya limita todo a la cuenta.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { fetchAccountTemplates } from "@/lib/settings/account-catalog";
import { variablesDelCuerpo } from "@/lib/flows/fichas";
import type { MessageTemplate } from "@/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow, TextRow } from "./fields";

type FormT = ReturnType<typeof useTranslations>;

interface Props {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: FormT;
}

function Campo({ label, children, ayuda }: { label: string; children: React.ReactNode; ayuda?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
      {ayuda ? <p className="mt-1 text-[10px] text-muted-foreground">{ayuda}</p> : null}
    </div>
  );
}

// ============================================================
// Botón Pago / SPEI
// ============================================================

export function SendPaymentForm({ node, allNodes, onUpdateConfig, t }: Props) {
  const c = node.config as {
    clabe?: string;
    beneficiario?: string;
    banco?: string;
    monto?: number;
    referencia?: string;
    mensaje?: string;
    con_boton?: boolean;
    espera_minutos?: number;
    etiqueta_al_aprobar?: string;
    aprobado_next?: string;
    rechazado_next?: string;
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("paymentAmount")}>
          <Input
            type="number"
            min={1}
            step="0.01"
            value={c.monto ?? ""}
            onChange={(e) => onUpdateConfig({ monto: Math.max(Number(e.target.value) || 0, 0) })}
            className="bg-muted"
          />
        </Campo>
        <Campo label={t("paymentWait")}>
          <Input
            type="number"
            min={1}
            max={23 * 60}
            value={c.espera_minutos ?? 120}
            onChange={(e) =>
              onUpdateConfig({
                espera_minutos: Math.min(Math.max(Number(e.target.value) || 0, 1), 23 * 60),
              })
            }
            className="bg-muted"
          />
        </Campo>
      </div>
      <Campo label={t("paymentClabe")} ayuda={t("paymentClabeHelp")}>
        <Input
          value={c.clabe ?? ""}
          inputMode="numeric"
          maxLength={22}
          onChange={(e) => onUpdateConfig({ clabe: e.target.value.replace(/[^\d ]/g, "") })}
          placeholder="012345678901234567"
          className="bg-muted font-mono text-xs"
        />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("paymentHolder")}>
          <Input
            value={c.beneficiario ?? ""}
            onChange={(e) => onUpdateConfig({ beneficiario: e.target.value })}
            className="bg-muted"
          />
        </Campo>
        <Campo label={t("paymentBank")}>
          <Input
            value={c.banco ?? ""}
            onChange={(e) => onUpdateConfig({ banco: e.target.value })}
            className="bg-muted"
          />
        </Campo>
      </div>
      <Campo label={t("paymentReference")}>
        <Input
          value={c.referencia ?? ""}
          onChange={(e) => onUpdateConfig({ referencia: e.target.value })}
          className="bg-muted"
        />
      </Campo>
      <TextRow
        label={t("paymentMessage")}
        value={c.mensaje ?? ""}
        onChange={(v) => onUpdateConfig({ mensaje: v })}
        rows={2}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div>
          <p className="text-xs font-medium text-foreground">{t("paymentButton")}</p>
          <p className="text-[10px] text-muted-foreground">{t("paymentButtonHelp")}</p>
        </div>
        <Switch
          checked={Boolean(c.con_boton)}
          onCheckedChange={(v) => onUpdateConfig({ con_boton: !!v })}
          aria-label={t("paymentButton")}
        />
      </div>
      <Campo label={t("paymentTag")} ayuda={t("paymentTagHelp")}>
        <Input
          value={c.etiqueta_al_aprobar ?? "pagado"}
          onChange={(e) => onUpdateConfig({ etiqueta_al_aprobar: e.target.value })}
          className="bg-muted"
        />
      </Campo>
      <NextNodeRow
        value={c.aprobado_next ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ aprobado_next: v })}
        label={t("paymentIfApproved")}
      />
      <NextNodeRow
        value={c.rechazado_next ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ rechazado_next: v })}
        label={t("paymentIfRejected")}
      />
    </>
  );
}

// ============================================================
// Template WhatsApp
// ============================================================

/** Fichas que se pueden elegir para cada {{n}}. */
const FICHAS = [
  { valor: "{{contact.name}}", clave: "tokenName" },
  { valor: "{{contact.phone}}", clave: "tokenPhone" },
  { valor: "{{contact.email}}", clave: "tokenEmail" },
  { valor: "{{contact.company}}", clave: "tokenCompany" },
] as const;

export function SendTemplateForm({ node, allNodes, onUpdateConfig, t }: Props) {
  const c = node.config as {
    template_name?: string;
    language?: string;
    variables?: Record<string, string>;
    next_node_key?: string;
  };
  const { account } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [plantillas, setPlantillas] = useState<MessageTemplate[]>([]);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);

  const cargar = useCallback(async () => {
    if (!account?.id) return;
    setCargando(true);
    try {
      const todas = await fetchAccountTemplates(supabase, account.id);
      // Solo las aprobadas por Meta se pueden mandar.
      setPlantillas(todas.filter((p) => String(p.status).toUpperCase() === "APPROVED"));
    } catch {
      toast.error(t("templateLoadFailed"));
    } finally {
      setCargando(false);
    }
  }, [account?.id, supabase, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const sincronizar = async () => {
    setSincronizando(true);
    try {
      const res = await fetch("/api/whatsapp/templates/sync", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      await cargar();
      toast.success(t("templateSynced"));
    } catch {
      toast.error(t("templateSyncFailed"));
    } finally {
      setSincronizando(false);
    }
  };

  const clave = (p: { name: string; language?: string | null }) => `${p.name}::${p.language ?? ""}`;
  const elegida = plantillas.find(
    (p) => p.name === c.template_name && (p.language ?? "") === (c.language ?? ""),
  );
  const numeros = elegida ? variablesDelCuerpo(elegida.body_text ?? "") : [];

  return (
    <>
      <Campo label={t("templateLabel")} ayuda={t("templateHelp")}>
        <div className="flex gap-2">
          <Select
            value={c.template_name ? `${c.template_name}::${c.language ?? ""}` : ""}
            onValueChange={(v) => {
              const p = plantillas.find((x) => clave(x) === v);
              if (p) onUpdateConfig({ template_name: p.name, language: p.language ?? "es_MX", variables: {} });
            }}
          >
            <SelectTrigger className="flex-1 bg-muted">
              {elegida ? (
                <SelectValue>{`${elegida.name} (${elegida.language})`}</SelectValue>
              ) : (
                <SelectValue placeholder={cargando ? t("loading") : t("templatePick")} />
              )}
            </SelectTrigger>
            <SelectContent>
              {plantillas.map((p) => (
                <SelectItem key={clave(p)} value={clave(p)}>
                  {p.name} ({p.language})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => void sincronizar()}
            disabled={sincronizando}
            title={t("templateSync")}
            aria-label={t("templateSync")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
        {!cargando && plantillas.length === 0 ? (
          <p className="mt-1 text-[10px] text-amber-400">{t("templateNoneApproved")}</p>
        ) : null}
      </Campo>

      {elegida ? (
        <div className="rounded-lg border border-border bg-muted/40 p-2.5 text-[12px] whitespace-pre-wrap text-foreground/90">
          {elegida.body_text}
        </div>
      ) : null}

      {numeros.map((n) => {
        const valor = c.variables?.[n] ?? "";
        const ficha = FICHAS.find((f) => f.valor === valor);
        const esFicha = Boolean(ficha);
        return (
          <Campo key={n} label={t("templateVariable", { n })}>
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={esFicha ? valor : "__texto"}
                onValueChange={(v) =>
                  onUpdateConfig({
                    variables: { ...(c.variables ?? {}), [n]: v === "__texto" ? "" : v },
                  })
                }
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue>{ficha ? t(ficha.clave) : t("tokenCustomText")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {FICHAS.map((f) => (
                    <SelectItem key={f.valor} value={f.valor}>
                      {t(f.clave)}
                    </SelectItem>
                  ))}
                  <SelectItem value="__texto">{t("tokenCustomText")}</SelectItem>
                </SelectContent>
              </Select>
              {!esFicha ? (
                <Input
                  value={valor}
                  onChange={(e) =>
                    onUpdateConfig({ variables: { ...(c.variables ?? {}), [n]: e.target.value } })
                  }
                  placeholder={t("tokenCustomPlaceholder")}
                  className="bg-muted text-xs"
                />
              ) : null}
            </div>
          </Campo>
        );
      })}

      <NextNodeRow
        value={c.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}

// ============================================================
// Kanban
// ============================================================

interface Embudo {
  id: string;
  name: string;
}
interface Etapa {
  id: string;
  name: string;
  color: string;
  position: number;
  pipeline_id: string;
}

export function MoveKanbanForm({ node, allNodes, onUpdateConfig, t }: Props) {
  const c = node.config as {
    pipeline_id?: string;
    stage_id?: string;
    crear_si_no_existe?: boolean;
    titulo?: string;
    next_node_key?: string;
  };
  const { account } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [embudos, setEmbudos] = useState<Embudo[]>([]);
  const [etapas, setEtapas] = useState<Etapa[]>([]);

  useEffect(() => {
    if (!account?.id) return;
    let cancelado = false;
    (async () => {
      const [{ data: e }, { data: s }] = await Promise.all([
        supabase.from("pipelines").select("id, name").eq("account_id", account.id).order("created_at"),
        supabase.from("pipeline_stages").select("id, name, color, position, pipeline_id").order("position"),
      ]);
      if (cancelado) return;
      setEmbudos((e as Embudo[] | null) ?? []);
      setEtapas((s as Etapa[] | null) ?? []);
    })();
    return () => {
      cancelado = true;
    };
  }, [account?.id, supabase]);

  const etapasDelEmbudo = etapas.filter((s) => s.pipeline_id === c.pipeline_id);
  const embudoElegido = embudos.find((e) => e.id === c.pipeline_id);
  const etapaElegida = etapasDelEmbudo.find((s) => s.id === c.stage_id);

  return (
    <>
      <Campo label={t("kanbanPipeline")}>
        <Select
          value={c.pipeline_id ?? ""}
          onValueChange={(v) => onUpdateConfig({ pipeline_id: v, stage_id: "", stage_name: "" })}
        >
          <SelectTrigger className="bg-muted">
            {embudoElegido ? (
              <SelectValue>{embudoElegido.name}</SelectValue>
            ) : (
              <SelectValue placeholder={t("kanbanPickPipeline")} />
            )}
          </SelectTrigger>
          <SelectContent>
            {embudos.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Campo>
      <Campo label={t("kanbanStage")}>
        <Select
          value={c.stage_id ?? ""}
          onValueChange={(v) => {
            const etapa = etapasDelEmbudo.find((s) => s.id === v);
            onUpdateConfig({ stage_id: v, stage_name: etapa?.name ?? "" });
          }}
        >
          <SelectTrigger className="bg-muted">
            {etapaElegida ? (
              <SelectValue>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: etapaElegida.color }} />
                  {etapaElegida.name}
                </span>
              </SelectValue>
            ) : (
              <SelectValue placeholder={t("kanbanPickStage")} />
            )}
          </SelectTrigger>
          <SelectContent>
            {etapasDelEmbudo.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Campo>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div>
          <p className="text-xs font-medium text-foreground">{t("kanbanCreate")}</p>
          <p className="text-[10px] text-muted-foreground">{t("kanbanCreateHelp")}</p>
        </div>
        <Switch
          checked={c.crear_si_no_existe !== false}
          onCheckedChange={(v) => onUpdateConfig({ crear_si_no_existe: !!v })}
          aria-label={t("kanbanCreate")}
        />
      </div>
      {c.crear_si_no_existe !== false ? (
        <Campo label={t("kanbanTitle")} ayuda={t("kanbanTitleHelp")}>
          <Input
            value={c.titulo ?? "{{contact.name}}"}
            onChange={(e) => onUpdateConfig({ titulo: e.target.value })}
            className="bg-muted text-xs"
          />
        </Campo>
      ) : null}
      <NextNodeRow
        value={c.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}
