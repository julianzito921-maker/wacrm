"use client";

/**
 * «Editar esperar respuesta»: panel del bloque save_reply.
 *
 * Siete controles: espera indefinida, tiempo máximo con unidad, buffer de
 * mensajes, citar la respuesta, reaccionar con 👍, campo donde guardar y
 * mensaje previo con formato. Las dos salidas se conectan en la tarjeta
 * del lienzo, no aquí.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bold, Braces, Italic, Smile, Strikethrough } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import {
  BUFFER_MAX_SEGUNDOS,
  ESPERA_MAX_SEGUNDOS,
  type SaveReplyNodeConfig,
} from "@/lib/flows/types";
import type { BuilderNode } from "../shared";

type FormT = ReturnType<typeof useTranslations>;

type Unidad = "segundos" | "minutos" | "horas" | "dias";

const FACTOR: Record<Unidad, number> = {
  segundos: 1,
  minutos: 60,
  horas: 3600,
  dias: 86400,
};

const EMOJIS = [
  "😀", "😊", "🙌", "👍", "👏", "🔥", "✅", "🎉",
  "💬", "📌", "📦", "🛒", "💳", "🎁", "⏰", "📅",
  "❤️", "🙏", "👀", "💡", "🚀", "😉", "🤝", "⭐",
];

function unidadInicial(segundos: number): Unidad {
  if (segundos > 0 && segundos % 86400 === 0) return "dias";
  if (segundos > 0 && segundos % 3600 === 0) return "horas";
  if (segundos > 0 && segundos % 60 === 0) return "minutos";
  return "segundos";
}

function esperaDe(cfg: SaveReplyNodeConfig): number {
  if (typeof cfg.espera_segundos === "number" && Number.isFinite(cfg.espera_segundos)) {
    return cfg.espera_segundos;
  }
  const minutos = Number(cfg.espera_minutos);
  return Number.isFinite(minutos) ? minutos * 60 : 0;
}

export function EsperarRespuestaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SaveReplyNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: FormT;
}) {
  const segundos = esperaDe(cfg);
  const [unidad, setUnidad] = useState<Unidad>(() => unidadInicial(segundos));
  const [emojisAbiertos, setEmojisAbiertos] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [campos, setCampos] = useState<Array<{ id: string; field_name: string }>>([]);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("custom_fields")
          .select("id, field_name")
          .order("field_name");
        if (vivo) setCampos((data ?? []) as Array<{ id: string; field_name: string }>);
      } catch {
        // Sin campos personalizados el select sigue con los base.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  const variables = useMemo(() => {
    const claves = new Set<string>();
    for (const n of allNodes) {
      if (n.node_key === currentKey) continue;
      if (n.node_type !== "save_reply" && n.node_type !== "collect_input") continue;
      const k = (n.config as { var_key?: unknown }).var_key;
      if (typeof k === "string" && k.trim()) claves.add(k.trim());
    }
    return [...claves].sort();
  }, [allNodes, currentKey]);

  const escribirEspera = (valor: number, u: Unidad = unidad) => {
    const total = Math.min(
      Math.max(Math.round(valor * FACTOR[u]), 0),
      ESPERA_MAX_SEGUNDOS,
    );
    onUpdateConfig({
      espera_segundos: total,
      // Compatibilidad con el motor desplegado antes de este cambio.
      espera_minutos: Math.max(1, Math.ceil(total / 60)),
    });
  };

  const insertar = (texto: string, marca?: string) => {
    const actual = cfg.prompt_text ?? "";
    const el = promptRef.current;
    if (!el) {
      onUpdateConfig({ prompt_text: actual + texto });
      return;
    }
    const desde = el.selectionStart ?? actual.length;
    const hasta = el.selectionEnd ?? actual.length;
    const sel = actual.slice(desde, hasta);
    const cuerpo = marca ? (sel || texto) : texto;
    const nuevo = marca
      ? `${actual.slice(0, desde)}${marca}${cuerpo}${marca}${actual.slice(hasta)}`
      : `${actual.slice(0, desde)}${cuerpo}${actual.slice(hasta)}`;
    onUpdateConfig({ prompt_text: nuevo });
    const cursor = marca
      ? desde + marca.length + cuerpo.length
      : desde + cuerpo.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  const indefinido = Boolean(cfg.esperar_indefinido);
  const buffer = Number(cfg.buffer_segundos) || 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="border-border bg-card rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-foreground text-sm font-medium">{t("waitIndefinitely")}</p>
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              {t("waitIndefinitelyHelp")}
            </p>
          </div>
          <Switch
            checked={indefinido}
            onCheckedChange={(v) =>
              onUpdateConfig({
                esperar_indefinido: Boolean(v),
                // Sin timeout no hay segunda salida que mantener.
                ...(v ? { no_contesto_next: "" } : {}),
              })
            }
            aria-label={t("waitIndefinitely")}
          />
        </div>
      </div>

      <div className={indefinido ? "pointer-events-none opacity-40" : ""}>
        <label className="text-muted-foreground mb-1 block text-xs">
          {t("maxWait")}
        </label>
        <div className="flex gap-2">
          <Input
            type="number"
            min={1}
            max={ESPERA_MAX_SEGUNDOS / FACTOR[unidad]}
            step={1}
            value={Number((segundos / FACTOR[unidad]).toFixed(2))}
            onChange={(e) => escribirEspera(Number(e.target.value) || 0)}
            className="bg-muted flex-1"
            disabled={indefinido}
            aria-label={t("maxWait")}
          />
          <Select
            value={unidad}
            onValueChange={(v) => setUnidad(v as Unidad)}
            disabled={indefinido}
          >
            <SelectTrigger className="bg-muted w-[128px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="segundos">{t("unitSeconds")}</SelectItem>
              <SelectItem value="minutos">{t("unitMinutes")}</SelectItem>
              <SelectItem value="horas">{t("unitHours")}</SelectItem>
              <SelectItem value="dias">{t("unitDays")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-border bg-card rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-foreground text-sm font-medium">{t("bufferLabel")}</p>
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              {t("bufferHelp")}
            </p>
          </div>
          <Switch
            checked={buffer > 0}
            onCheckedChange={(v) => onUpdateConfig({ buffer_segundos: v ? 5 : 0 })}
            aria-label={t("bufferLabel")}
          />
        </div>
        {buffer > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={BUFFER_MAX_SEGUNDOS}
              value={buffer}
              onChange={(e) =>
                onUpdateConfig({
                  buffer_segundos: Math.min(
                    Math.max(Number(e.target.value) || 0, 1),
                    BUFFER_MAX_SEGUNDOS,
                  ),
                })
              }
              className="bg-muted w-24"
              aria-label={t("bufferSeconds")}
            />
            <span className="text-muted-foreground text-xs">
              {t("bufferSecondsUnit", { max: BUFFER_MAX_SEGUNDOS })}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground text-xs">{t("quoteReply")}</span>
          <Switch
            checked={Boolean(cfg.citar_respuesta)}
            onCheckedChange={(v) => onUpdateConfig({ citar_respuesta: Boolean(v) })}
            aria-label={t("quoteReply")}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground text-xs">{t("reactReply")}</span>
          <Switch
            checked={Boolean(cfg.reaccionar)}
            onCheckedChange={(v) => onUpdateConfig({ reaccionar: Boolean(v) })}
            aria-label={t("reactReply")}
          />
        </div>
      </div>

      <div>
        <label className="text-muted-foreground mb-1 block text-xs">
          {t("saveField")}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px]">
              vars.
            </span>
            <Input
              value={cfg.var_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({
                  var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
              className="bg-muted pl-11 font-mono text-xs"
              aria-label={t("saveField")}
            />
          </div>
          <Select
            value={cfg.campo_contacto || "__none"}
            onValueChange={(v) =>
              onUpdateConfig({ campo_contacto: v === "__none" ? "" : v })
            }
          >
            <SelectTrigger className="bg-muted w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t("contactFieldNone")}</SelectItem>
              <SelectItem value="name">{t("contactFieldName")}</SelectItem>
              <SelectItem value="email">{t("contactFieldEmail")}</SelectItem>
              <SelectItem value="company">{t("contactFieldCompany")}</SelectItem>
              {campos.map((c) => (
                <SelectItem key={c.id} value={`custom:${c.id}`}>
                  {c.field_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground mt-1 text-[10px]">
          {t("saveFieldHelp")}
        </p>
      </div>

      <div>
        <label className="text-muted-foreground mb-1 block text-xs">
          {t("promptLabel")}
        </label>
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <div className="border-border flex items-center gap-0.5 border-b px-1.5 py-1">
            <ToolbarButton label={t("fmtBold")} onClick={() => insertar(t("fmtText"), "*")}>
              <Bold className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label={t("fmtItalic")} onClick={() => insertar(t("fmtText"), "_")}>
              <Italic className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label={t("fmtStrike")} onClick={() => insertar(t("fmtText"), "~")}>
              <Strikethrough className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              label={t("fmtEmoji")}
              onClick={() => setEmojisAbiertos((v) => !v)}
            >
              <Smile className="h-3.5 w-3.5" />
            </ToolbarButton>
            <span className="mx-1 h-3.5 w-px bg-border" />
            <Braces className="text-muted-foreground h-3.5 w-3.5" />
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) insertar(`{{vars.${e.target.value}}}`);
              }}
              className="text-muted-foreground hover:text-foreground h-6 flex-1 cursor-pointer bg-transparent text-[11px] outline-none"
              aria-label={t("fmtVars")}
            >
              <option value="">{variables.length ? t("fmtVars") : t("varsEmpty")}</option>
              {variables.map((v) => (
                <option key={v} value={v}>
                  {`{{vars.${v}}}`}
                </option>
              ))}
            </select>
          </div>
          {emojisAbiertos && (
            <div className="border-border grid grid-cols-8 gap-0.5 border-b p-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => insertar(e)}
                  className="hover:bg-muted rounded py-1 text-base leading-none"
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={promptRef}
            value={cfg.prompt_text ?? ""}
            onChange={(e) => onUpdateConfig({ prompt_text: e.target.value })}
            rows={4}
            placeholder={t("promptPlaceholder")}
            className="rounded-none border-0 bg-transparent text-sm focus-visible:ring-0"
          />
        </div>
        <p className="text-muted-foreground mt-1 text-[10px]">{t("promptHelp")}</p>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-6 w-6 items-center justify-center rounded transition-colors"
    >
      {children}
    </button>
  );
}
