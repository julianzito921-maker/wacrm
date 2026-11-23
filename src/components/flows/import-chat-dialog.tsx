"use client";

/**
 * Importador de un chat de WhatsApp (.zip) a un flujo.
 *
 * El .zip no sale del navegador: se descomprime con `fflate`, se
 * identifica el .txt y los medios, y solo los medios elegidos se suben a
 * Storage. El flujo se crea como borrador con `POST /api/flows`.
 */

import { useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileArchive, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_BYTES_BY_KIND,
  deleteAccountMedia,
  uploadAccountMedia,
} from "@/lib/storage/upload-media";
import {
  type ChatMediaKind,
  type ParsedChat,
} from "@/lib/flows/whatsapp-chat-parser";
import {
  ChatZipError,
  parseChatZipEntries,
  type ChatZipMedia,
} from "@/lib/flows/whatsapp-chat-zip";
import {
  buildChatFlow,
  tieneIncidenciasBloqueantes,
  type BuildIssue,
} from "@/lib/flows/whatsapp-chat-to-flow";
import { cn } from "@/lib/utils";

type Fase = "elegir" | "confirmar" | "subiendo" | "listo";

interface ZipLeido {
  nombre: string;
  chat: ParsedChat;
  medios: Map<string, ChatZipMedia>;
  variosTxt: boolean;
}

type ClaveIncidencia =
  | "missing"
  | "tooLarge"
  | "badFormat"
  | "omitted"
  | "unsupported"
  | "capped"
  | "businessFirst"
  | "captionSplit"
  | "firstMedia"
  | "systemLines"
  | "ambiguousDates"
  | "unparsed"
  | "noCustomer"
  | "noBusiness";

interface Incidencia {
  clave: ClaveIncidencia;
  detail?: string;
  maxMb?: number;
  count?: number;
  seconds?: number;
  blocking: boolean;
}

const MB = 1024 * 1024;

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  "3gp": "video/3gp",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  amr: "audio/amr",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

/** Lo que Meta acepta de verdad (no solo lo que el bucket admite). */
const FORMATO_OK: Record<ChatMediaKind, RegExp> = {
  image: /^(jpe?g|png)$/i,
  video: /^(mp4|3gp)$/i,
  audio: /^(opus|ogg|m4a|mp3|aac|amr)$/i,
  sticker: /^webp$/i,
  document: /^(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i,
};

const LIMITE: Record<ChatMediaKind, number> = {
  image: MEDIA_MAX_BYTES_BY_KIND.image,
  video: MEDIA_MAX_BYTES_BY_KIND.video,
  audio: MEDIA_MAX_BYTES_BY_KIND.audio,
  document: MEDIA_MAX_BYTES_BY_KIND.document,
  sticker: MEDIA_MAX_BYTES,
};

function extension(nombre: string): string {
  return nombre.split(".").pop()?.toLowerCase() ?? "";
}

function claveMedia(nombre: string): string {
  return nombre.trim().toLowerCase();
}

function incidenciasDeZip(zip: ZipLeido, negocio: string): Incidencia[] {
  const out: Incidencia[] = [];
  for (const m of zip.chat.messages) {
    if (m.author !== negocio) continue;
    if (m.unsupported) {
      out.push({ clave: "unsupported", detail: m.unsupported, blocking: true });
      continue;
    }
    if (m.omitted) {
      out.push({ clave: "omitted", blocking: true });
      continue;
    }
    if (!m.media) continue;
    const archivo = zip.medios.get(claveMedia(m.media.filename));
    if (!archivo) {
      out.push({ clave: "missing", detail: m.media.filename, blocking: true });
      continue;
    }
    if (!FORMATO_OK[m.media.kind].test(extension(archivo.nombre))) {
      out.push({ clave: "badFormat", detail: m.media.filename, blocking: true });
    }
    const tope = LIMITE[m.media.kind];
    if (archivo.size > tope) {
      out.push({
        clave: "tooLarge",
        detail: m.media.filename,
        maxMb: Math.round(tope / MB),
        blocking: true,
      });
    }
  }
  for (const i of zip.chat.issues) {
    if (i.code === "ambiguous_dates") {
      out.push({ clave: "ambiguousDates", blocking: false });
    }
    if (i.code === "system_lines") {
      out.push({ clave: "systemLines", count: i.count, blocking: false });
    }
    if (i.code === "unparsed_lines") {
      out.push({ clave: "unparsed", count: i.count, blocking: false });
    }
  }
  return out;
}

function incidenciasDeConstruccion(issues: BuildIssue[]): Incidencia[] {
  const out: Incidencia[] = [];
  for (const i of issues) {
    switch (i.code) {
      case "media_missing":
        out.push({ clave: "missing", detail: i.detail, blocking: true });
        break;
      case "omitted_media":
        out.push({ clave: "omitted", blocking: true });
        break;
      case "unsupported_message":
        out.push({
          clave: "unsupported",
          detail: i.detail,
          blocking: true,
        });
        break;
      case "delay_capped":
        out.push({
          clave: "capped",
          seconds: i.seconds,
          blocking: false,
        });
        break;
      case "business_first":
        out.push({ clave: "businessFirst", blocking: false });
        break;
      case "caption_split":
        out.push({
          clave: "captionSplit",
          detail: i.detail,
          blocking: false,
        });
        break;
      case "first_message_media":
        out.push({ clave: "firstMedia", blocking: false });
        break;
      case "no_customer_messages":
        out.push({ clave: "noCustomer", blocking: true });
        break;
      case "no_business_messages":
        out.push({ clave: "noBusiness", blocking: true });
        break;
      default:
        break;
    }
  }
  return out;
}

export function ImportChatDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Flows.importChat");
  const locale = useLocale();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const importandoRef = useRef(false);

  const [fase, setFase] = useState<Fase>("elegir");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [zip, setZip] = useState<ZipLeido | null>(null);
  const [negocio, setNegocio] = useState("");
  const [nombre, setNombre] = useState("");
  const [trigger, setTrigger] = useState<"keyword" | "any_message">("keyword");
  const [ignorar, setIgnorar] = useState(false);
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [finales, setFinales] = useState<Incidencia[]>([]);
  const [progreso, setProgreso] = useState({ hechos: 0, total: 0 });
  const [flowId, setFlowId] = useState("");

  const participantes = zip?.chat.participants ?? [];
  const cliente = participantes.find((p) => p.name !== negocio)?.name ?? "";
  const mensajesNegocio = useMemo(() => {
    if (!zip || !negocio) return 0;
    return zip.chat.messages.filter((m) => m.author === negocio).length;
  }, [zip, negocio]);
  const mediosNegocio = useMemo(() => {
    if (!zip || !negocio) return 0;
    return zip.chat.messages.filter((m) => m.author === negocio && m.media).length;
  }, [zip, negocio]);
  const bloqueantes = incidencias.filter((i) => i.blocking);

  const reiniciar = () => {
    setFase("elegir");
    setCargando(false);
    setError("");
    setZip(null);
    setNegocio("");
    setNombre("");
    setTrigger("keyword");
    setIgnorar(false);
    setIncidencias([]);
    setFinales([]);
    setProgreso({ hechos: 0, total: 0 });
    setFlowId("");
  };

  const leerZip = async (archivo: File) => {
    setCargando(true);
    setError("");
    try {
      if (archivo.size > 300 * MB) throw new Error(t("errTooBig"));
      const { unzipSync } = await import("fflate");
      const datos = new Uint8Array(await archivo.arrayBuffer());
      let entradas: Record<string, Uint8Array>;
      try {
        entradas = unzipSync(datos);
      } catch {
        throw new Error(t("errZip"));
      }
      let leido;
      try {
        leido = parseChatZipEntries(entradas, {
          preferDayFirst: !locale.toLowerCase().startsWith("en"),
        });
      } catch (err) {
        if (err instanceof ChatZipError) {
          if (err.code === "no_txt") throw new Error(t("errNoTxt"));
          if (err.code === "group_chat") throw new Error(t("errGroup"));
          if (err.code === "one_sided") throw new Error(t("errOneSided"));
          throw new Error(t("errNoMessages"));
        }
        throw err;
      }
      setZip({
        nombre: archivo.name,
        chat: leido.chat,
        medios: leido.medios,
        variosTxt: leido.variosTxt,
      });
      setNegocio("");
      setNombre("");
      setTrigger("keyword");
      setIgnorar(false);
      setIncidencias([]);
      setFase("confirmar");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errZip"));
    } finally {
      setCargando(false);
    }
  };

  const elegirNegocio = (nombreParticipante: string) => {
    if (!zip) return;
    setNegocio(nombreParticipante);
    const otro = zip.chat.participants.find(
      (p) => p.name !== nombreParticipante,
    );
    setNombre(otro ? t("defaultName", { name: otro.name }) : "");
    const primerCliente = zip.chat.messages.find(
      (m) => m.author !== nombreParticipante,
    );
    setTrigger(primerCliente?.text.trim() ? "keyword" : "any_message");
    setIncidencias(incidenciasDeZip(zip, nombreParticipante));
  };

  const importar = async () => {
    if (!zip || !negocio || importandoRef.current) return;
    importandoRef.current = true;
    setFase("subiendo");
    setError("");
    const subidos: string[] = [];
    let flujoCreado = false;
    const limpiarSubidos = async () => {
      await Promise.allSettled(
        subidos.map((ruta) => deleteAccountMedia("flow-media", ruta)),
      );
    };
    try {
      const referenciados = new Map<string, ChatZipMedia>();
      for (const m of zip.chat.messages) {
        if (m.author !== negocio || !m.media) continue;
        const clave = claveMedia(m.media.filename);
        const archivo = zip.medios.get(clave);
        if (!archivo) continue;
        if (!FORMATO_OK[m.media.kind].test(extension(archivo.nombre))) continue;
        if (archivo.size > LIMITE[m.media.kind]) continue;
        referenciados.set(clave, archivo);
      }

      const mediaUrls = new Map<string, string>();
      let hechos = 0;
      setProgreso({ hechos, total: referenciados.size });
      for (const [clave, archivo] of referenciados) {
        const tipo = MIME[extension(archivo.nombre)] ?? "application/octet-stream";
        const blob = new Blob(
          [archivo.bytes.slice().buffer as ArrayBuffer],
          { type: tipo },
        );
        const file = new File([blob], archivo.nombre, { type: tipo });
        const { publicUrl, path } = await uploadAccountMedia("flow-media", file);
        subidos.push(path);
        mediaUrls.set(clave, publicUrl);
        hechos += 1;
        setProgreso({ hechos, total: referenciados.size });
      }

      const flow = buildChatFlow({
        chat: zip.chat,
        businessName: negocio,
        mediaUrls,
        trigger,
      });
      const nuevas = incidenciasDeConstruccion(flow.issues);
      if (tieneIncidenciasBloqueantes(flow.issues) && !ignorar) {
        // Se subieron medios para un flujo que no se va a crear.
        await limpiarSubidos();
        setIncidencias(nuevas);
        setFase("confirmar");
        return;
      }

      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          import_flow: {
            name: nombre.trim() || t("defaultName", { name: cliente }),
            description: t("importedFrom", { file: zip.nombre }),
            trigger_type: flow.trigger_type,
            trigger_config: flow.trigger_config,
            entry_node_id: "start",
            nodes: flow.nodes,
          },
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("errCreate"));
      }
      flujoCreado = true;
      const creado = (await res.json()) as { flow: { id: string } };
      setFinales(nuevas);
      setFlowId(creado.flow.id);
      setFase("listo");
    } catch (err) {
      if (!flujoCreado) await limpiarSubidos();
      setError(err instanceof Error ? err.message : t("errCreate"));
      setFase("confirmar");
    } finally {
      importandoRef.current = false;
    }
  };

  const textoIncidencia = (i: Incidencia): string => {
    switch (i.clave) {
      case "missing":
        return t("issues.missing", { file: i.detail ?? "" });
      case "tooLarge":
        return t("issues.tooLarge", {
          file: i.detail ?? "",
          max: i.maxMb ?? 0,
        });
      case "badFormat":
        return t("issues.badFormat", { file: i.detail ?? "" });
      case "omitted":
        return t("issues.omitted");
      case "unsupported": {
        const tipos: Record<string, string> = {
          eliminado: "deleted",
          ubicacion: "location",
          contacto: "contact",
          encuesta: "poll",
          ver_una_vez: "viewOnce",
        };
        return t("issues.unsupported", {
          kind: t(`kinds.${tipos[i.detail ?? ""] ?? "deleted"}`),
        });
      }
      case "capped":
        return t("issues.capped", { hours: Math.round((i.seconds ?? 0) / 3600) });
      case "businessFirst":
        return t("issues.businessFirst");
      case "captionSplit":
        return t("issues.captionSplit", { file: i.detail ?? "" });
      case "firstMedia":
        return t("issues.firstMedia");
      case "systemLines":
        return t("issues.systemLines", { count: i.count ?? 0 });
      case "ambiguousDates":
        return t("issues.ambiguousDates");
      case "unparsed":
        return t("issues.unparsed", { count: i.count ?? 0 });
      case "noCustomer":
        return t("issues.noCustomer");
      case "noBusiness":
        return t("issues.noBusiness");
      default:
        return "";
    }
  };

  const ListaIncidencias = ({ items }: { items: Incidencia[] }) => {
    if (items.length === 0) {
      return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          {t("noIssues")}
        </p>
      );
    }
    return (
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {items.map((i, idx) => (
          <li
            key={`${i.clave}-${idx}`}
            className={cn(
              "flex items-start gap-1.5 text-[11.5px] leading-snug",
              i.blocking ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{textoIncidencia(i)}</span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setTimeout(reiniciar, 200);
      }}
    >
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="h-4 w-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        {fase === "elegir" && (
          <div className="flex flex-col gap-3">
            <input
              ref={inputRef}
              type="file"
              accept="application/zip,.zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void leerZip(f);
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={cargando}
              className="border-border hover:border-primary/60 hover:bg-muted/30 flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors disabled:opacity-60"
            >
              {cargando ? (
                <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              ) : (
                <FileArchive className="text-muted-foreground h-6 w-6" />
              )}
              <span className="text-sm font-medium">
                {cargando ? t("parsing") : t("chooseFile")}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {t("zipHint")}
              </span>
            </button>
            {error && (
              <p className="text-destructive text-xs">{error}</p>
            )}
          </div>
        )}

        {(fase === "confirmar" || fase === "subiendo") && zip && (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
            <div>
              <p className="text-foreground mb-1.5 text-xs font-medium">
                {t("participantsTitle")}
              </p>
              <p className="text-muted-foreground mb-2 text-[11px]">
                {t("participantsHelp")}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {participantes.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => elegirNegocio(p.name)}
                    disabled={fase === "subiendo"}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      negocio === p.name
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:border-primary/40",
                    )}
                  >
                    <span className="text-foreground block truncate text-sm font-medium">
                      {p.name}
                    </span>
                    <span className="text-muted-foreground text-[11px]">
                      {t("messagesCount", { count: p.count })}
                    </span>
                    {negocio === p.name && (
                      <span className="text-primary mt-1 block text-[10px] font-semibold uppercase">
                        {t("businessBadge")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {t("flowName")}
                </Label>
                <Input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  className="bg-muted"
                  disabled={fase === "subiendo"}
                />
              </div>
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {t("triggerLabel")}
                </Label>
                <Select
                  value={trigger}
                  onValueChange={(v) =>
                    setTrigger(v as "keyword" | "any_message")
                  }
                  disabled={fase === "subiendo"}
                >
                  <SelectTrigger className="bg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keyword">{t("triggerKeyword")}</SelectItem>
                    <SelectItem value="any_message">{t("triggerAny")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="border-border bg-card grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-4">
              <Dato label={t("statsMessages")} value={zip.chat.messages.length} />
              <Dato label={t("statsBusiness")} value={mensajesNegocio} />
              <Dato label={t("statsMedia")} value={mediosNegocio} />
              <Dato
                label={t("statsDays")}
                value={
                  zip.chat.messages.length
                    ? Math.max(
                        1,
                        Math.ceil(
                          (zip.chat.messages[zip.chat.messages.length - 1].at.getTime() -
                            zip.chat.messages[0].at.getTime()) /
                            86_400_000,
                        ),
                      )
                    : 0
                }
              />
            </div>

            {zip.variosTxt && (
              <p className="text-muted-foreground text-[11px]">
                {t("multiTxt")}
              </p>
            )}

            <div>
              <p className="text-foreground mb-1.5 text-xs font-medium">
                {t("issuesTitle")}
              </p>
              <ListaIncidencias
                items={incidencias}
              />
              {bloqueantes.length > 0 && (
                <label className="border-border bg-muted/30 mt-2 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5">
                  <Checkbox
                    checked={ignorar}
                    onCheckedChange={(v) => setIgnorar(v === true)}
                    className="mt-0.5"
                    disabled={fase === "subiendo"}
                  />
                  <span>
                    <span className="text-foreground block text-xs font-medium">
                      {t("ignoreIssues")}
                    </span>
                    <span className="text-muted-foreground block text-[10.5px] leading-snug">
                      {t("ignoreIssuesHelp")}
                    </span>
                  </span>
                </label>
              )}
            </div>

            {fase === "subiendo" && (
              <div className="flex flex-col gap-1.5">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-primary h-full transition-all"
                    style={{
                      width:
                        progreso.total > 0
                          ? `${Math.round((progreso.hechos / progreso.total) * 100)}%`
                          : "15%",
                    }}
                  />
                </div>
                <p className="text-muted-foreground text-[11px]">
                  {progreso.total > 0
                    ? t("uploadingMedia", {
                        done: progreso.hechos,
                        total: progreso.total,
                      })
                    : t("creatingFlow")}
                </p>
              </div>
            )}

            {error && <p className="text-destructive text-xs">{error}</p>}
          </div>
        )}

        {fase === "listo" && (
          <div className="flex flex-col gap-3">
            <p className="text-foreground flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              {t("successTitle")}
            </p>
            <p className="text-muted-foreground text-xs">{t("successDesc")}</p>
            <ListaIncidencias items={finales} />
          </div>
        )}

        <DialogFooter>
          {fase === "elegir" && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
          )}
          {(fase === "confirmar" || fase === "subiendo") && (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={fase === "subiendo"}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => void importar()}
                disabled={
                  !negocio ||
                  fase === "subiendo" ||
                  (bloqueantes.length > 0 && !ignorar)
                }
              >
                {fase === "subiendo" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("importing")}
                  </>
                ) : (
                  t("import")
                )}
              </Button>
            </>
          )}
          {fase === "listo" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                onClick={() => {
                  router.push(`/flows/${flowId}`);
                  onOpenChange(false);
                }}
              >
                {t("openFlow")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Dato({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-muted-foreground truncate text-[9px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </div>
      <div className="text-foreground font-mono text-sm">{value}</div>
    </div>
  );
}
