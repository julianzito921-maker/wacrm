"use client";

/**
 * Formularios de los bloques de cierre del Flow Builder (migración 095):
 * intervalo programado, departamento, HTTP, pasarela, multimedia IA y
 * llamada oficial.
 *
 * Se mantienen en un archivo aparte de `bloques-finales-forms.tsx`
 * (que cubre los bloques de la 093) para que cada tanda se pueda
 * revisar y probar sin mezclar responsabilidades.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ClipboardPaste, Loader2, Plus, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { parsearCurl } from "@/lib/flows/curl";
import { AI_MEDIA_EDGE_VOICES, type WaitNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;

interface BaseFormProps {
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}

function Campo({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-muted-foreground">{label}</label>
      {children}
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Fila({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// ============================================================
// Intervalo inteligente
// ============================================================

const DIAS = [
  [1, "L"],
  [2, "M"],
  [3, "M"],
  [4, "J"],
  [5, "V"],
  [6, "S"],
  [7, "D"],
] as const;

export function IntervaloForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & { cfg: WaitNodeConfig }) {
  const modo = cfg.modo ?? "intervalo";
  const [fecha, setFecha] = useState(() =>
    cfg.fecha_objetivo ? cfg.fecha_objetivo.slice(0, 16) : "",
  );
  const horario = cfg.horario ?? {
    usar_cuenta: true,
    dias: [1, 2, 3, 4, 5],
    desde: "09:00",
    hasta: "18:00",
  };

  return (
    <>
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {[
          ["intervalo", t("waitTabInterval")],
          ["fecha", t("waitTabDate")],
          ["horario", t("waitTabHours")],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onUpdateConfig({ modo: id })}
            className={
              "rounded-md px-2 py-1.5 text-[11px] font-medium " +
              (modo === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {modo === "intervalo" ? (
        <Campo label={t("waitSecondsLabel")} hint={t("waitPatternHelp")}>
          <Input
            type="number"
            min={1}
            max={82_800}
            value={cfg.segundos ?? 15}
            onChange={(e) =>
              onUpdateConfig({ segundos: Math.max(1, Number(e.target.value) || 1) })
            }
            className="bg-muted"
          />
        </Campo>
      ) : null}

      {modo === "fecha" ? (
        <Campo label={t("waitDateLabel")} hint={t("waitDateHelp")}>
          <Input
            type="datetime-local"
            value={fecha}
            onChange={(e) => {
              setFecha(e.target.value);
              onUpdateConfig({
                fecha_objetivo: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : "",
              });
            }}
            className="bg-muted"
          />
        </Campo>
      ) : null}

      {modo === "horario" ? (
        <div className="space-y-3">
          <Fila
            label={t("waitUseAccountHours")}
            checked={horario.usar_cuenta !== false}
            onChange={(v) =>
              onUpdateConfig({
                horario: { ...horario, usar_cuenta: v },
              })
            }
          />
          {horario.usar_cuenta === false ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  {t("waitDaysLabel")}
                </label>
                <div className="flex gap-1">
                  {DIAS.map(([d, label]) => {
                    const activo = (horario.dias ?? []).includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => {
                          const dias = new Set(horario.dias ?? []);
                          if (activo) dias.delete(d);
                          else dias.add(d);
                          onUpdateConfig({
                            horario: { ...horario, dias: [...dias].sort() },
                          });
                        }}
                        className={
                          "size-8 rounded-md border text-[11px] " +
                          (activo
                            ? "border-primary bg-primary-soft text-primary"
                            : "border-border text-muted-foreground")
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Campo label={t("waitFromLabel")}>
                  <Input
                    type="time"
                    value={horario.desde ?? "09:00"}
                    onChange={(e) =>
                      onUpdateConfig({
                        horario: { ...horario, desde: e.target.value },
                      })
                    }
                    className="bg-muted"
                  />
                </Campo>
                <Campo label={t("waitToLabel")}>
                  <Input
                    type="time"
                    value={horario.hasta ?? "18:00"}
                    onChange={(e) =>
                      onUpdateConfig({
                        horario: { ...horario, hasta: e.target.value },
                      })
                    }
                    className="bg-muted"
                  />
                </Campo>
              </div>
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              {t("waitAccountHoursHelp")}
            </p>
          )}
        </div>
      ) : null}

      {modo !== "intervalo" ? (
        <NextNodeRow
          value={cfg.fuera_ventana_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ fuera_ventana_next: v })}
          label={t("waitOutsideWindowNext")}
        />
      ) : null}

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}

// ============================================================
// Departamento
// ============================================================

interface Departamento {
  id: string;
  name: string;
  color: string;
}

export function DepartmentForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & {
  cfg: { department_id?: string; department_name?: string; next_node_key?: string };
}) {
  const { account } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);

  useEffect(() => {
    if (!account?.id) return;
    let cancelado = false;
    (async () => {
      const { data } = await supabase
        .from("departments")
        .select("id, name, color")
        .eq("account_id", account.id)
        .eq("is_active", true)
        .order("sort_order");
      if (!cancelado) setDepartamentos((data as Departamento[] | null) ?? []);
    })();
    return () => {
      cancelado = true;
    };
  }, [account?.id, supabase]);

  const elegido = departamentos.find((d) => d.id === cfg.department_id);

  return (
    <>
      <Campo
        label={t("departmentLabel")}
        hint={t("departmentHelp")}
      >
        <Select
          value={cfg.department_id ?? ""}
          onValueChange={(v) => {
            const dep = departamentos.find((d) => d.id === v);
            onUpdateConfig({
              department_id: v,
              department_name: dep?.name ?? "",
            });
          }}
        >
          <SelectTrigger className="bg-muted">
            {elegido ? (
              <SelectValue>{elegido.name}</SelectValue>
            ) : (
              <SelectValue placeholder={t("departmentPick")} />
            )}
          </SelectTrigger>
          <SelectContent>
            {departamentos.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: d.color }}
                  />
                  {d.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Campo>
      {departamentos.length === 0 ? (
        <p className="text-[10px] text-amber-500">
          {t("departmentEmpty")}
        </p>
      ) : null}
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}

// ============================================================
// Integración HTTP
// ============================================================

interface RespuestaTest {
  status: number;
  ok: boolean;
  duration_ms: number;
  preview: string;
  mapped?: Record<string, string>;
}

export function HttpRequestForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & {
  cfg: import("@/lib/flows/types").HttpRequestNodeConfig;
}) {
  const [tab, setTab] = useState<"headers" | "body" | "map">("headers");
  const [probando, setProbando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaTest | null>(null);
  const [curlOpen, setCurlOpen] = useState(false);
  const [curl, setCurl] = useState("");
  const [credenciales, setCredenciales] = useState<Array<{ id: string; name: string }>>([]);
  const headers = cfg.headers ?? [];
  const mapa = cfg.response_map ?? [];

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/flow-credentials");
        const json = (await res.json()) as {
          credentials?: Array<{ id: string; name: string }>;
        };
        if (!cancelado && res.ok) setCredenciales(json.credentials ?? []);
      } catch {
        /* el formulario sigue funcionando sin credenciales */
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const pegarCurl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        aplicarCurl(text);
        return;
      }
    } catch {
      /* sin permiso de portapapeles */
    }
    setCurlOpen(true);
  };

  const aplicarCurl = (text: string) => {
    try {
      const parsed = parsearCurl(text);
      const cuerpo = parsed.body.trim();
      const esJson = cuerpo.startsWith("{") || cuerpo.startsWith("[");
      onUpdateConfig({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body_type: cuerpo ? (esJson ? "json" : "form") : "none",
        body: parsed.body ?? "",
      });
      setCurlOpen(false);
      setCurl("");
      toast.success(t("httpCurlOk"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("httpCurlError"));
    }
  };

  const probar = async () => {
    setProbando(true);
    setResultado(null);
    try {
      const res = await fetch("/api/flows/http-request/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      const json = (await res.json()) as RespuestaTest & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResultado(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("httpTestError"));
    } finally {
      setProbando(false);
    }
  };

  return (
    <div className="space-y-3">
      <Campo label={t("httpMethodUrl")}>
        <div className="flex gap-2">
          <Select
            value={cfg.method ?? "GET"}
            onValueChange={(v) => onUpdateConfig({ method: v })}
          >
            <SelectTrigger className="w-24 bg-muted">
              <SelectValue>{cfg.method ?? "GET"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {["GET", "POST", "PUT", "DELETE"].map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={cfg.url ?? ""}
            onChange={(e) => onUpdateConfig({ url: e.target.value })}
            placeholder="https://api.ejemplo.com/webhook/{{vars.id}}"
            className="bg-muted"
          />
        </div>
      </Campo>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={pegarCurl}>
          <ClipboardPaste className="mr-1 size-3.5" />
          {t("httpPasteCurl")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={probar}
          disabled={probando || !cfg.url?.trim()}
        >
          {probando ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1 size-3.5" />
          )}
          {t("httpTest")}
        </Button>
      </div>

      {curlOpen ? (
        <div className="space-y-2 rounded-lg border border-border p-2">
          <Textarea
            value={curl}
            onChange={(e) => setCurl(e.target.value)}
            rows={4}
            placeholder="curl 'https://...' -H 'Authorization: Bearer ...'"
            className="bg-muted font-mono text-[11px]"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => aplicarCurl(curl)}>
              {t("httpCurlApply")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCurlOpen(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {resultado ? (
        <div className="rounded-lg border border-border bg-muted/40 p-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className={resultado.ok ? "text-emerald-500" : "text-red-500"}>
              {resultado.status} · {resultado.duration_ms} ms
            </span>
          </div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
            {resultado.preview?.slice(0, 2000)}
          </pre>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {[
          ["headers", t("httpTabHeaders")],
          ["body", t("httpTabBody")],
          ["map", t("httpTabMap")],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as typeof tab)}
            className={
              "rounded-md px-2 py-1.5 text-[11px] font-medium " +
              (tab === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "headers" ? (
        <div className="space-y-2">
          <Campo label={t("httpCredential")} hint={t("httpCredentialHelp")}>
            <Select
              value={cfg.credential_id ?? "__none__"}
              onValueChange={(v) => {
                const cred = credenciales.find((c) => c.id === v);
                onUpdateConfig({
                  credential_id: v === "__none__" ? "" : v,
                  credential_name: cred?.name ?? "",
                });
              }}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue>
                  {credenciales.find((c) => c.id === cfg.credential_id)?.name ??
                    t("httpNoCredential")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("httpNoCredential")}</SelectItem>
                {credenciales.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Campo>
          {headers.map((h, i) => (
            <div key={i} className="flex gap-1">
              <Input
                value={h.key}
                onChange={(e) => {
                  const next = headers.map((x, j) =>
                    j === i ? { ...x, key: e.target.value } : x,
                  );
                  onUpdateConfig({ headers: next });
                }}
                placeholder="Content-Type"
                className="w-32 bg-muted font-mono text-[11px]"
              />
              <Input
                value={h.value}
                onChange={(e) => {
                  const next = headers.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x,
                  );
                  onUpdateConfig({ headers: next });
                }}
                placeholder="application/json"
                className="bg-muted font-mono text-[11px]"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() =>
                  onUpdateConfig({ headers: headers.filter((_, j) => j !== i) })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onUpdateConfig({ headers: [...headers, { key: "", value: "" }] })
            }
          >
            <Plus className="mr-1 size-3.5" />
            {t("httpAddHeader")}
          </Button>
          <p className="text-[10px] text-amber-500">{t("httpSecretWarning")}</p>
        </div>
      ) : null}

      {tab === "body" ? (
        <div className="space-y-2">
          <Campo label={t("httpBodyType")}>
            <Select
              value={cfg.body_type ?? "none"}
              onValueChange={(v) => onUpdateConfig({ body_type: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue>{cfg.body_type ?? "none"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">none</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="form">form-urlencoded</SelectItem>
                <SelectItem value="raw">raw</SelectItem>
              </SelectContent>
            </Select>
          </Campo>
          {cfg.body_type !== "none" ? (
            <Textarea
              value={cfg.body ?? ""}
              onChange={(e) => onUpdateConfig({ body: e.target.value })}
              rows={6}
              className="bg-muted font-mono text-[11px]"
              placeholder='{"cliente":"{{contact.name}}"}'
            />
          ) : null}
        </div>
      ) : null}

      {tab === "map" ? (
        <div className="space-y-2">
          {mapa.map((m, i) => (
            <div key={i} className="flex gap-1">
              <Input
                value={m.path}
                onChange={(e) => {
                  const next = mapa.map((x, j) =>
                    j === i ? { ...x, path: e.target.value } : x,
                  );
                  onUpdateConfig({ response_map: next });
                }}
                placeholder="data.id"
                className="bg-muted font-mono text-[11px]"
              />
              <Input
                value={m.var_key}
                onChange={(e) => {
                  const next = mapa.map((x, j) =>
                    j === i ? { ...x, var_key: e.target.value } : x,
                  );
                  onUpdateConfig({ response_map: next });
                }}
                placeholder="pedido_id"
                className="w-32 bg-muted font-mono text-[11px]"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() =>
                  onUpdateConfig({
                    response_map: mapa.filter((_, j) => j !== i),
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onUpdateConfig({
                response_map: [...mapa, { path: "", var_key: "" }],
              })
            }
          >
            <Plus className="mr-1 size-3.5" />
            {t("httpAddMap")}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("httpTimeout")}>
          <Input
            type="number"
            min={1000}
            max={30000}
            value={cfg.timeout_ms ?? 15000}
            onChange={(e) =>
              onUpdateConfig({ timeout_ms: Number(e.target.value) || 15000 })
            }
            className="bg-muted"
          />
        </Campo>
        <Campo label={t("httpStatusVar")}>
          <Input
            value={cfg.status_var ?? ""}
            onChange={(e) => onUpdateConfig({ status_var: e.target.value })}
            placeholder="http_status"
            className="bg-muted font-mono text-[11px]"
          />
        </Campo>
      </div>

      <Fila
        label={t("httpContinueOnError")}
        checked={cfg.continue_on_error !== false}
        onChange={(v) => onUpdateConfig({ continue_on_error: v })}
      />

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
      <NextNodeRow
        value={cfg.error_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ error_next: v })}
        label={t("httpErrorNext")}
      />
    </div>
  );
}

// ============================================================
// Pasarela de pagos
// ============================================================

interface Embudo {
  id: string;
  name: string;
}
interface Etapa {
  id: string;
  name: string;
  color: string;
  pipeline_id: string;
}

export function PaymentGatewayForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & {
  cfg: import("@/lib/flows/types").PaymentGatewayNodeConfig;
}) {
  const { account } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [embudos, setEmbudos] = useState<Embudo[]>([]);
  const [etapas, setEtapas] = useState<Etapa[]>([]);

  useEffect(() => {
    if (!account?.id) return;
    let cancelado = false;
    (async () => {
      const [{ data: e }, { data: s }] = await Promise.all([
        supabase
          .from("pipelines")
          .select("id, name")
          .eq("account_id", account.id)
          .order("created_at"),
        supabase
          .from("pipeline_stages")
          .select("id, name, color, pipeline_id")
          .order("position"),
      ]);
      if (cancelado) return;
      setEmbudos((e as Embudo[] | null) ?? []);
      setEtapas((s as Etapa[] | null) ?? []);
    })();
    return () => {
      cancelado = true;
    };
  }, [account?.id, supabase]);

  const etapasDelEmbudo = etapas.filter((s) => s.pipeline_id === cfg.pipeline_id);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("gatewayProvider")}>
          <Select
            value={cfg.provider ?? "stripe"}
            onValueChange={(v) => onUpdateConfig({ provider: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue>{cfg.provider ?? "stripe"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[
                ["stripe", "Stripe"],
                ["mercadopago", "Mercado Pago"],
                ["hotmart", "Hotmart"],
                ["whop", "Whop"],
                ["spei", "SPEI"],
              ].map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Campo>
        <Campo label={t("gatewayCurrency")}>
          <Select
            value={cfg.currency ?? "MXN"}
            onValueChange={(v) => onUpdateConfig({ currency: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue>{cfg.currency ?? "MXN"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MXN">MXN</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
            </SelectContent>
          </Select>
        </Campo>
      </div>

      <Campo label={t("gatewayAmountMode")}>
        <Select
          value={cfg.amount_mode ?? "fixed"}
          onValueChange={(v) => onUpdateConfig({ amount_mode: v })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue>
              {cfg.amount_mode === "variable"
                ? t("gatewayAmountVariable")
                : t("gatewayAmountFixed")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">{t("gatewayAmountFixed")}</SelectItem>
            <SelectItem value="variable">{t("gatewayAmountVariable")}</SelectItem>
          </SelectContent>
        </Select>
      </Campo>

      {cfg.amount_mode === "variable" ? (
        <Campo label={t("gatewayAmountVar")}>
          <Input
            value={cfg.amount_var ?? ""}
            onChange={(e) => onUpdateConfig({ amount_var: e.target.value })}
            placeholder="monto"
            className="bg-muted font-mono text-[11px]"
          />
        </Campo>
      ) : (
        <Campo label={t("gatewayAmount")}>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={cfg.amount ?? 99}
            onChange={(e) => onUpdateConfig({ amount: Number(e.target.value) || 0 })}
            className="bg-muted"
          />
        </Campo>
      )}

      {cfg.provider !== "spei" ? (
        <Campo label={t("gatewayCheckout")} hint={t("gatewayCheckoutHelp")}>
          <Input
            value={cfg.checkout_url ?? ""}
            onChange={(e) => onUpdateConfig({ checkout_url: e.target.value })}
            placeholder="https://checkout.../?ref={{payment_ref}}"
            className="bg-muted"
          />
        </Campo>
      ) : (
        <p className="rounded-lg border border-border bg-muted/40 p-2 text-[10px] text-muted-foreground">
          {t("gatewaySpeiHelp")}
        </p>
      )}

      <Campo label={t("gatewayMessage")}>
        <Textarea
          value={cfg.message ?? ""}
          onChange={(e) => onUpdateConfig({ message: e.target.value })}
          rows={2}
          placeholder={t("gatewayMessagePlaceholder")}
          className="bg-muted"
        />
      </Campo>

      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("gatewayWait")}>
          <Input
            type="number"
            min={5}
            max={43200}
            value={cfg.wait_minutes ?? 120}
            onChange={(e) =>
              onUpdateConfig({ wait_minutes: Number(e.target.value) || 120 })
            }
            className="bg-muted"
          />
        </Campo>
        <Campo label={t("gatewayTemplate")}>
          <Input
            value={cfg.template_name ?? ""}
            onChange={(e) => onUpdateConfig({ template_name: e.target.value })}
            placeholder="pago_link"
            className="bg-muted font-mono text-[11px]"
          />
        </Campo>
      </div>

      <Campo label={t("gatewayPipeline")} hint={t("gatewayPipelineHelp")}>
        <Select
          value={cfg.pipeline_id ?? "__none__"}
          onValueChange={(v) =>
            onUpdateConfig({
              pipeline_id: v === "__none__" ? "" : v,
              stage_id: "",
            })
          }
        >
          <SelectTrigger className="bg-muted">
            <SelectValue>
              {embudos.find((e) => e.id === cfg.pipeline_id)?.name ??
                t("gatewayNoPipeline")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("gatewayNoPipeline")}</SelectItem>
            {embudos.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Campo>

      {cfg.pipeline_id ? (
        <Campo label={t("gatewayStage")}>
          <Select
            value={cfg.stage_id ?? ""}
            onValueChange={(v) => onUpdateConfig({ stage_id: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder={t("gatewayPickStage")}>
                {etapasDelEmbudo.find((e) => e.id === cfg.stage_id)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {etapasDelEmbudo.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Campo>
      ) : null}

      <div className="grid gap-2">
        <Fila
          label={t("gatewaySendCapi")}
          checked={cfg.send_capi === true}
          onChange={(v) => onUpdateConfig({ send_capi: v })}
        />
        <Fila
          label={t("gatewayNotify")}
          checked={cfg.notify !== false}
          onChange={(v) => onUpdateConfig({ notify: v })}
        />
      </div>

      <NextNodeRow
        value={cfg.approved_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ approved_next: v })}
        label={t("gatewayApprovedNext")}
      />
      <NextNodeRow
        value={cfg.rejected_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ rejected_next: v })}
        label={t("gatewayRejectedNext")}
      />
      <NextNodeRow
        value={cfg.timeout_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ timeout_next: v })}
        label={t("gatewayTimeoutNext")}
      />
    </div>
  );
}

// ============================================================
// Multimedia IA
// ============================================================

export function AiMediaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & {
  cfg: import("@/lib/flows/types").AiMediaNodeConfig;
}) {
  const kind = cfg.kind ?? "audio";
  const audio = cfg.audio ?? {
    provider: "edge",
    voice: "es-MX-DaliaNeural",
    text: "",
    format: "mp3",
  };
  const image = cfg.image ?? {
    provider: "pollinations",
    prompt: "",
    enhance_prompt: true,
    width: 1024,
    height: 1024,
    model: "flux",
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {[
          ["audio", t("aiMediaAudio")],
          ["image", t("aiMediaImage")],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onUpdateConfig({ kind: id })}
            className={
              "rounded-md px-2 py-1.5 text-[11px] font-medium " +
              (kind === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {kind === "audio" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Campo label={t("aiMediaProvider")}>
              <Select
                value={audio.provider}
                onValueChange={(v) =>
                  onUpdateConfig({ audio: { ...audio, provider: v } })
                }
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue>{audio.provider}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="edge">Edge-TTS (gratis)</SelectItem>
                  <SelectItem value="openai">OpenAI TTS</SelectItem>
                </SelectContent>
              </Select>
            </Campo>
            <Campo label={t("aiMediaVoice")}>
              <Select
                value={audio.voice}
                onValueChange={(v) =>
                  onUpdateConfig({ audio: { ...audio, voice: v } })
                }
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue>{audio.voice}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {AI_MEDIA_EDGE_VOICES.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="alloy">OpenAI · alloy</SelectItem>
                  <SelectItem value="nova">OpenAI · nova</SelectItem>
                </SelectContent>
              </Select>
            </Campo>
          </div>
          <Campo label={t("aiMediaText")} hint={t("aiMediaTextHelp")}>
            <Textarea
              value={audio.text}
              onChange={(e) =>
                onUpdateConfig({ audio: { ...audio, text: e.target.value } })
              }
              rows={4}
              className="bg-muted"
            />
          </Campo>
          <Campo label={t("aiMediaFormat")}>
            <Select
              value={audio.format ?? "mp3"}
              onValueChange={(v) =>
                onUpdateConfig({ audio: { ...audio, format: v } })
              }
            >
              <SelectTrigger className="bg-muted">
                <SelectValue>{audio.format ?? "mp3"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mp3">MP3 (audio)</SelectItem>
                <SelectItem value="ogg">OGG/Opus (nota de voz)</SelectItem>
              </SelectContent>
            </Select>
          </Campo>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Campo label={t("aiMediaProvider")}>
              <Select
                value={image.provider}
                onValueChange={(v) =>
                  onUpdateConfig({ image: { ...image, provider: v } })
                }
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue>{image.provider}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pollinations">Pollinations (gratis)</SelectItem>
                  <SelectItem value="together">Together / FLUX</SelectItem>
                  <SelectItem value="flux">FLUX</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                </SelectContent>
              </Select>
            </Campo>
            <Campo label={t("aiMediaModel")}>
              <Input
                value={image.model ?? ""}
                onChange={(e) =>
                  onUpdateConfig({ image: { ...image, model: e.target.value } })
                }
                placeholder="flux"
                className="bg-muted font-mono text-[11px]"
              />
            </Campo>
          </div>
          <Campo label={t("aiMediaPrompt")} hint={t("aiMediaPromptHelp")}>
            <Textarea
              value={image.prompt}
              onChange={(e) =>
                onUpdateConfig({ image: { ...image, prompt: e.target.value } })
              }
              rows={4}
              className="bg-muted"
            />
          </Campo>
          <Fila
            label={t("aiMediaEnhance")}
            checked={image.enhance_prompt !== false}
            onChange={(v) =>
              onUpdateConfig({ image: { ...image, enhance_prompt: v } })
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <Campo label={t("aiMediaWidth")}>
              <Input
                type="number"
                min={256}
                max={1536}
                value={image.width ?? 1024}
                onChange={(e) =>
                  onUpdateConfig({
                    image: { ...image, width: Number(e.target.value) || 1024 },
                  })
                }
                className="bg-muted"
              />
            </Campo>
            <Campo label={t("aiMediaHeight")}>
              <Input
                type="number"
                min={256}
                max={1536}
                value={image.height ?? 1024}
                onChange={(e) =>
                  onUpdateConfig({
                    image: { ...image, height: Number(e.target.value) || 1024 },
                  })
                }
                className="bg-muted"
              />
            </Campo>
          </div>
        </>
      )}

      <Campo label={t("aiMediaOutputVar")} hint={t("aiMediaOutputVarHelp")}>
        <Input
          value={cfg.output_var ?? "ai_media_url"}
          onChange={(e) => onUpdateConfig({ output_var: e.target.value })}
          className="bg-muted font-mono text-[11px]"
        />
      </Campo>

      <Fila
        label={t("aiMediaSendNow")}
        checked={cfg.send_now === true}
        onChange={(v) => onUpdateConfig({ send_now: v })}
      />

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </div>
  );
}

// ============================================================
// Llamada oficial
// ============================================================

export function OfficialCallForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: BaseFormProps & {
  cfg: import("@/lib/flows/types").OfficialCallNodeConfig;
}) {
  const { account } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [conexionId, setConexionId] = useState<string | null>(null);
  const [estado, setEstado] = useState<{
    available: boolean;
    detail?: string | null;
    country?: string | null;
  } | null>(null);
  const [verificando, setVerificando] = useState(false);

  useEffect(() => {
    if (!account?.id) return;
    let cancelado = false;
    (async () => {
      const { data } = await supabase
        .from("whatsapp_connections")
        .select("id")
        .eq("account_id", account.id)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (!cancelado) setConexionId((data as { id?: string } | null)?.id ?? null);
    })();
    return () => {
      cancelado = true;
    };
  }, [account?.id, supabase]);

  const verificar = async () => {
    if (!conexionId) return;
    setVerificando(true);
    try {
      const res = await fetch(`/api/connections/${conexionId}/calling-check`, {
        method: "POST",
      });
      const json = (await res.json()) as {
        available?: boolean;
        detail?: string | null;
        country?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "error");
      setEstado({
        available: json.available === true,
        detail: json.detail ?? null,
        country: json.country ?? null,
      });
    } catch {
      toast.error(t("officialCallCheckFailed"));
    } finally {
      setVerificando(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-600 dark:text-amber-400">
        {t("officialCallNotice")}
      </div>

      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-2">
        <span className="text-[10px] text-muted-foreground">
          {estado
            ? estado.available
              ? t("officialCallAvailable", { country: estado.country ?? "—" })
              : estado.detail || t("officialCallUnavailable")
            : t("officialCallCheckHint")}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void verificar()}
          disabled={verificando || !conexionId}
        >
          {verificando ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("officialCallCheck")}
        </Button>
      </div>

      <Campo label={t("officialCallMode")}>
        <Select
          value={cfg.mode ?? "permission"}
          onValueChange={(v) => onUpdateConfig({ mode: v })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue>
              {cfg.mode === "call"
                ? t("officialCallModeCall")
                : t("officialCallModePermission")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="permission">
              {t("officialCallModePermission")}
            </SelectItem>
            <SelectItem value="call">{t("officialCallModeCall")}</SelectItem>
          </SelectContent>
        </Select>
      </Campo>

      <Campo label={t("officialCallText")}>
        <Textarea
          value={cfg.body_text ?? ""}
          onChange={(e) => onUpdateConfig({ body_text: e.target.value })}
          rows={3}
          className="bg-muted"
        />
      </Campo>

      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("officialCallTemplate")}>
          <Input
            value={cfg.template_name ?? ""}
            onChange={(e) => onUpdateConfig({ template_name: e.target.value })}
            placeholder="permiso_llamada"
            className="bg-muted font-mono text-[11px]"
          />
        </Campo>
        <Campo label={t("officialCallLanguage")}>
          <Input
            value={cfg.template_language ?? "es_MX"}
            onChange={(e) => onUpdateConfig({ template_language: e.target.value })}
            className="bg-muted font-mono text-[11px]"
          />
        </Campo>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Campo label={t("officialCallWaitDays")}>
          <Input
            type="number"
            min={1}
            max={7}
            value={cfg.wait_days ?? 7}
            onChange={(e) =>
              onUpdateConfig({ wait_days: Number(e.target.value) || 7 })
            }
            className="bg-muted"
          />
        </Campo>
        <Campo label={t("officialCallBridge")}>
          <Select
            value={cfg.call_bridge ?? "none"}
            onValueChange={(v) => onUpdateConfig({ call_bridge: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue>
                {cfg.call_bridge === "sip"
                  ? "SIP"
                  : t("officialCallBridgeNone")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("officialCallBridgeNone")}</SelectItem>
              <SelectItem value="sip">SIP</SelectItem>
            </SelectContent>
          </Select>
        </Campo>
      </div>

      <NextNodeRow
        value={cfg.granted_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ granted_next: v })}
        label={t("officialCallGrantedNext")}
      />
      <NextNodeRow
        value={cfg.denied_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ denied_next: v })}
        label={t("officialCallDeniedNext")}
      />
      <NextNodeRow
        value={cfg.timeout_next ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ timeout_next: v })}
        label={t("officialCallTimeoutNext")}
      />
    </div>
  );
}
