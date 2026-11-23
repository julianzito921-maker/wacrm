"use client";

/**
 * «Editar mensaje»: el bloque Mensaje como contenedor multimensaje.
 *
 * Apila burbujas que el motor manda en orden (texto, imagen, video,
 * audio, archivo, sticker e intervalo). Cada burbuja trae su
 * «escribiendo…» (0–60 s) y un switch para reaccionar con 👍 al último
 * mensaje de la clienta antes de mandarla. Abajo, la cuadrícula
 * «Añadir contenido».
 *
 * Un nodo viejo (solo `text`) se muestra como una burbuja de texto; en
 * cuanto se edita, se guarda en el formato nuevo (`items`).
 */

import { useCallback, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  Mic,
  Paperclip,
  Sticker,
  Timer,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import {
  BURBUJA_ESCRIBIENDO_DEFECTO,
  BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS,
  WAIT_INLINE_MAX_SEGUNDOS,
  type BurbujaMensaje,
  type TipoBurbuja,
} from "@/lib/flows/types";
import { EMOJI_BURBUJA, type BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { SmartDelayField } from "./node-config-form";

type FormT = ReturnType<typeof useTranslations>;

const ACEPTA: Partial<Record<TipoBurbuja, string>> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  // OGG/Opus se muestra en WhatsApp como nota de voz.
  audio: "audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
  // WhatsApp solo acepta stickers en .webp.
  sticker: "image/webp",
};

const AGREGAR: { tipo: TipoBurbuja; icon: typeof MessageCircle }[] = [
  { tipo: "text", icon: MessageCircle },
  { tipo: "image", icon: ImageIcon },
  { tipo: "video", icon: Video },
  { tipo: "audio", icon: Mic },
  { tipo: "document", icon: FileText },
  { tipo: "sticker", icon: Sticker },
  { tipo: "interval", icon: Timer },
];

function nuevaBurbuja(tipo: TipoBurbuja): BurbujaMensaje {
  if (tipo === "interval") return { tipo, segundos: 5 };
  return {
    tipo,
    text: "",
    ...(tipo === "text" ? {} : { media_url: "" }),
    segundos: BURBUJA_ESCRIBIENDO_DEFECTO,
    like: false,
  };
}

interface MensajeCfg {
  text?: string;
  items?: BurbujaMensaje[];
  next_node_key?: string;
}

export function MensajeForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: MensajeCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: FormT;
}) {
  const items: BurbujaMensaje[] =
    Array.isArray(cfg.items) && cfg.items.length > 0
      ? cfg.items
      : cfg.text?.trim()
        ? [{ tipo: "text", text: cfg.text, segundos: BURBUJA_ESCRIBIENDO_DEFECTO, like: false }]
        : [];

  // `text` queda vacío: en el formato nuevo manda `items`.
  const guardar = (nuevos: BurbujaMensaje[]) => onUpdateConfig({ items: nuevos, text: "" });
  const cambiar = (i: number, patch: Partial<BurbujaMensaje>) =>
    guardar(items.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const quitar = (i: number) => guardar(items.filter((_, j) => j !== i));
  const mover = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const copia = [...items];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    guardar(copia);
  };

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {items.length === 0 && (
          <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
            {t("bubblesEmpty")}
          </p>
        )}
        {items.map((b, i) => (
          <BurbujaCard
            key={i}
            b={b}
            i={i}
            total={items.length}
            onChange={(patch) => cambiar(i, patch)}
            onRemove={() => quitar(i)}
            onMove={(d) => mover(i, d)}
            t={t}
          />
        ))}
      </div>

      <div>
        <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
          {t("addContent")}
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {AGREGAR.map((a) => (
            <button
              key={a.tipo}
              type="button"
              onClick={() => guardar([...items, nuevaBurbuja(a.tipo)])}
              className="border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-primary flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10.5px] transition-colors"
            >
              <a.icon className="h-4 w-4" />
              {t(`bubbleType_${a.tipo}`)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <NextNodeRow
          value={cfg.next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={t("advancesTo")}
        />
        <p className="text-muted-foreground mt-1 text-[10px]">{t("endOfBranchHelp")}</p>
      </div>
    </>
  );
}

function BurbujaCard({
  b,
  i,
  total,
  onChange,
  onRemove,
  onMove,
  t,
}: {
  b: BurbujaMensaje;
  i: number;
  total: number;
  onChange: (patch: Partial<BurbujaMensaje>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  t: FormT;
}) {
  const esIntervalo = b.tipo === "interval";
  const conPie = b.tipo === "image" || b.tipo === "video" || b.tipo === "document";
  const segundos = Number(b.segundos ?? BURBUJA_ESCRIBIENDO_DEFECTO);
  return (
    <div className="border-border bg-card rounded-lg border">
      <div className="border-border flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="text-sm leading-none">{EMOJI_BURBUJA[b.tipo] ?? "•"}</span>
        <span className="text-foreground flex-1 truncate text-[11px] font-semibold tracking-wider uppercase">
          {t(`bubbleType_${b.tipo}`)} · {i + 1}
        </span>
        <BotonIcono label={t("bubbleUp")} disabled={i === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3 w-3" />
        </BotonIcono>
        <BotonIcono label={t("bubbleDown")} disabled={i === total - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-3 w-3" />
        </BotonIcono>
        <BotonIcono label={t("bubbleRemove")} onClick={onRemove} peligro>
          <Trash2 className="h-3 w-3" />
        </BotonIcono>
      </div>

      <div className="flex flex-col gap-2.5 px-2.5 py-2.5">
        {esIntervalo ? (
          <SmartDelayField
            segundos={Math.max(1, segundos || 1)}
            onChange={(s) => onChange({ segundos: s })}
            t={t}
          />
        ) : (
          <>
            {b.tipo === "text" ? (
              <Textarea
                value={b.text ?? ""}
                onChange={(e) => onChange({ text: e.target.value })}
                rows={3}
                placeholder={t("bubbleTextPlaceholder")}
                className="bg-muted text-sm"
              />
            ) : (
              <ArchivoBurbuja b={b} onChange={onChange} t={t} />
            )}
            {conPie && (
              <Input
                value={b.text ?? ""}
                onChange={(e) => onChange({ text: e.target.value })}
                placeholder={t("captionLabel")}
                className="bg-muted text-xs"
              />
            )}
            {b.tipo === "document" && (
              <Input
                value={b.filename ?? ""}
                onChange={(e) => onChange({ filename: e.target.value })}
                placeholder={t("filenamePlaceholder")}
                className="bg-muted text-xs"
              />
            )}

            <div>
              <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                <span>{t("typingDelay")}</span>
                <span className="text-foreground font-mono">{segundos} s</span>
              </div>
              <input
                type="range"
                min={0}
                max={BURBUJA_ESCRIBIENDO_MAX_SEGUNDOS}
                step={1}
                value={segundos}
                onChange={(e) => onChange({ segundos: Number(e.target.value) })}
                aria-label={t("typingDelay")}
                className="accent-primary w-full"
              />
              {segundos > WAIT_INLINE_MAX_SEGUNDOS && (
                <p className="text-muted-foreground mt-0.5 text-[10px]">{t("typingDelayLongHelp")}</p>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-[11px]">{t("likeBeforeReply")}</span>
              <Switch
                checked={Boolean(b.like)}
                onCheckedChange={(v) => onChange({ like: !!v })}
                aria-label={t("likeBeforeReply")}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BotonIcono({
  label,
  onClick,
  disabled,
  peligro,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  peligro?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={
        "text-muted-foreground flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-30 " +
        (peligro ? "hover:bg-red-500/10 hover:text-red-500" : "hover:bg-muted hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

const FLOW_MEDIA_BUCKET = "flow-media";

function ArchivoBurbuja({
  b,
  onChange,
  t,
}: {
  b: BurbujaMensaje;
  onChange: (patch: Partial<BurbujaMensaje>) => void;
  t: FormT;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const nombre = b.filename || (b.media_url ? b.media_url.split("/").pop() ?? "" : "");

  const subir = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(t("fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }));
        return;
      }
      setSubiendo(true);
      try {
        const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
        onChange({ media_url: publicUrl, filename: file.name });
        toast.success(t("fileUploaded"));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setSubiendo(false);
      }
    },
    [onChange, t],
  );

  return (
    <div>
      {b.media_url ? (
        <div className="border-border bg-muted flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          <a
            href={b.media_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground min-w-0 flex-1 truncate hover:text-cyan-300"
            title={nombre || b.media_url}
          >
            {nombre || b.media_url}
          </a>
          <button
            type="button"
            onClick={() => onChange({ media_url: "", filename: "" })}
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1"
            aria-label={t("removeFile")}
            disabled={subiendo}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          disabled={subiendo}
          className="border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {subiendo ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("uploading")}
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              {b.tipo === "sticker" ? t("stickerUploadHint") : t("clickToUpload")}
            </>
          )}
        </button>
      )}
      <input
        ref={ref}
        type="file"
        accept={ACEPTA[b.tipo]}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subir(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
