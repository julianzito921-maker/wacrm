"use client";

/**
 * Celular de prueba del embudo (vista «Vista previa» del editor).
 *
 * El probador escribe como si fuera la clienta y ve, en un teléfono con
 * aspecto de WhatsApp, lo que el flujo le contestaría: textos, botones,
 * listas, fotos, pagos… El recorrido lo decide `lib/flows/simulador.ts`
 * con las mismas reglas que el motor real, sobre lo que hay en el editor
 * (aunque no esté guardado ni activo). Nada sale a WhatsApp.
 *
 * Al lado, el panel del probador: en qué paso va, qué variables y
 * etiquetas lleva, por dónde pasó y botones para forzar lo que en
 * producción haría el reloj o un webhook («Adelantar espera», «No
 * contesta», «Pago aprobado»…), para probar cada rama en segundos.
 *
 * La conversación se conserva al ir a editar un nodo y volver.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  CheckCheck,
  Copy,
  FileText,
  List as ListIcon,
  MessageSquare,
  Mic,
  MoreVertical,
  Paperclip,
  Pencil,
  Phone,
  Play,
  RotateCcw,
  Send,
  Smartphone,
  Sparkles,
  Video,
  X,
} from "lucide-react";

import { useFlowEditor } from "./flow-editor-state";
import { FlowPreview } from "./flow-preview";
import { NodeIconChip, summarizeNode, truncate, type BuilderNode, type NodeType } from "./shared";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  accion as simAccion,
  accionesDisponibles,
  arrancar,
  estadoInicial,
  recibir,
  type SimAccion,
  type SimEntrada,
  type SimEstado,
  type SimFlujo,
  type SimResultado,
  type SimSalida,
  type SimServicios,
} from "@/lib/flows/simulador";
import type { KeywordTriggerConfig } from "@/lib/flows/types";

// ============================================================
// Tipos de la conversación pintada
// ============================================================

type AvisoIa = {
  tipo: "ia";
  codigo: "ia_apagada" | "agente_modo" | "ia_pausada" | "ia_omitida" | "ia_error" | "ia_traspaso" | "ia_acciones";
  datos?: Record<string, string>;
};

type ItemChat =
  | { id: string; lado: "cliente"; entrada: SimEntrada; hora: string; reaccion?: string }
  | { id: string; lado: "negocio"; salida: SimSalida; hora: string; ia?: boolean }
  | { id: string; lado: "sistema"; salida: SimSalida | AvisoIa; hora: string };

type Velocidad = "real" | "rapida" | "instantanea";
const FACTOR: Record<Velocidad, number> = { real: 1, rapida: 0.15, instantanea: 0 };

interface Sesion {
  estado: SimEstado;
  items: ItemChat[];
}

/** Conversaciones por flujo: sobreviven al cambio de vista (ir a editar y volver). */
const sesiones = new Map<string, Sesion>();

const SALIDAS_DEL_NEGOCIO = new Set(["texto", "medio", "botones", "lista", "plantilla", "permiso_llamada"]);

let contador = 0;
const nuevoId = () => `m${Date.now().toString(36)}${(contador++).toString(36)}`;
const horaAhora = () =>
  new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function duracion(segundos: number): string {
  if (segundos >= 86_400) return `${Math.round((segundos / 86_400) * 10) / 10} d`;
  if (segundos >= 3600) return `${Math.round((segundos / 3600) * 10) / 10} h`;
  if (segundos >= 60) return `${Math.round(segundos / 60)} min`;
  return `${Math.round(segundos)} s`;
}

// ============================================================
// Componente principal
// ============================================================

export function FlowSimulator({ onEdit }: { onEdit: (key: string) => void }) {
  const t = useTranslations("Flows.simulator");
  const tNodos = useTranslations("Flows.builder");
  const { flow, state, dirty } = useFlowEditor();

  const [modo, setModo] = useState<"celular" | "recorrido">("celular");
  const [velocidad, setVelocidad] = useState<Velocidad>("rapida");
  const [iaTrasFlujo, setIaTrasFlujo] = useState(true);
  const [httpReal, setHttpReal] = useState(false);

  const previa = sesiones.get(flow.id);
  const [estado, setEstadoLocal] = useState<SimEstado>(() => previa?.estado ?? estadoInicial(flow.id));
  const [items, setItems] = useState<ItemChat[]>(() => previa?.items ?? []);
  const [ocupado, setOcupado] = useState(false);
  const [escribiendo, setEscribiendo] = useState(false);

  const estadoRef = useRef(estado);
  const itemsRef = useRef(items);
  const tokenRef = useRef(0);
  const flujosRef = useRef(new Map<string, SimFlujo>());

  const guardar = useCallback(() => {
    sesiones.set(flow.id, { estado: estadoRef.current, items: itemsRef.current });
  }, [flow.id]);

  const setEstado = useCallback(
    (e: SimEstado) => {
      estadoRef.current = e;
      setEstadoLocal(e);
      guardar();
    },
    [guardar],
  );
  const agregar = useCallback(
    (item: ItemChat) => {
      itemsRef.current = [...itemsRef.current, item];
      setItems(itemsRef.current);
      guardar();
    },
    [guardar],
  );

  // El flujo del editor, tal como está ahora (sin guardar incluido).
  const flujoEditor = useMemo<SimFlujo>(
    () => ({
      id: flow.id,
      name: state.name,
      trigger_type: state.trigger_type,
      trigger_config: state.trigger_config,
      entry_node_id: state.entry_node_id,
      fallback_policy: flow.fallback_policy,
      nodes: state.nodes,
    }),
    [flow.id, flow.fallback_policy, state.name, state.trigger_type, state.trigger_config, state.entry_node_id, state.nodes],
  );
  const flujoEditorRef = useRef(flujoEditor);
  flujoEditorRef.current = flujoEditor;

  const porClave = useMemo(() => new Map(state.nodes.map((n) => [n.node_key, n])), [state.nodes]);

  // Nombres de etiquetas y cuerpos de plantillas (solo lectura, para pintar).
  const [etiquetas, setEtiquetas] = useState<Map<string, string>>(new Map());
  const [plantillas, setPlantillas] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const supabase = createClient();
        const [tags, tpls] = await Promise.all([
          supabase.from("tags").select("id, name"),
          supabase.from("message_templates").select("name, language, body_text"),
        ]);
        if (!vivo) return;
        setEtiquetas(
          new Map(((tags.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name])),
        );
        setPlantillas(
          new Map(
            ((tpls.data ?? []) as Array<{ name: string; language: string | null; body_text: string }>).map((x) => [
              `${x.name}|${x.language ?? ""}`,
              x.body_text,
            ]),
          ),
        );
      } catch {
        // Solo cosmético: se muestran los ids.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // ---- servicios del simulador (rutas que no envían nada) ----
  const servicios = useMemo<SimServicios>(
    () => ({
      iaBloque: async ({ flujoId, nodo, historial, vars }) => {
        const res = await fetch("/api/flows/simular/ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modo: "bloque", flow_id: flujoId, config: nodo.config, historial, vars }),
        });
        if (!res.ok) return null;
        return (await res.json()) as { respuesta: string; salida: string | null };
      },
      http: httpReal
        ? async ({ cfg }) => {
            const res = await fetch("/api/flows/http-request/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ config: cfg }),
            });
            if (!res.ok) return null;
            const j = (await res.json()) as { ok: boolean; status: number; mapped?: Record<string, unknown> };
            return { ok: j.ok, status: j.status, mapped: j.mapped ?? {} };
          }
        : undefined,
      cargarFlujo: async (id) => {
        const guardado = flujosRef.current.get(id);
        if (guardado) return guardado;
        const res = await fetch(`/api/flows/${id}`);
        if (!res.ok) return null;
        const j = (await res.json()) as {
          flow: {
            id: string;
            name: string;
            status: string;
            trigger_type: SimFlujo["trigger_type"];
            trigger_config: Record<string, unknown>;
            entry_node_id: string | null;
            fallback_policy: unknown;
          };
          nodes: SimFlujo["nodes"];
        };
        // Igual que el motor: solo se puede conectar a un flujo activo.
        if (j.flow.status !== "active") return null;
        const f: SimFlujo = { ...j.flow, nodes: j.nodes };
        flujosRef.current.set(id, f);
        return f;
      },
    }),
    [httpReal],
  );

  /** Flujo sobre el que corre el siguiente paso. */
  const flujoDelPaso = useCallback(
    async (e: SimEstado): Promise<SimFlujo> => {
      if (e.fase === "activa" && e.flujoId !== flow.id) {
        const otro = flujosRef.current.get(e.flujoId) ?? (await servicios.cargarFlujo?.(e.flujoId));
        if (otro) return otro;
      }
      return flujoEditorRef.current;
    },
    [flow.id, servicios],
  );

  // ---- reproducción con «escribiendo…» ----
  const reproducir = useCallback(
    async (salidas: SimSalida[], token: number, ia = false) => {
      const factor = FACTOR[velocidad];
      for (const s of salidas) {
        if (token !== tokenRef.current) return;
        if (s.tipo === "pausa") {
          if (factor > 0) await dormir(Math.min(s.segundos * 1000 * factor, 15_000));
          continue;
        }
        if (s.tipo === "reaccion") {
          const lista = [...itemsRef.current];
          for (let i = lista.length - 1; i >= 0; i -= 1) {
            const it = lista[i];
            if (it.lado === "cliente") {
              lista[i] = { ...it, reaccion: s.emoji };
              break;
            }
          }
          itemsRef.current = lista;
          setItems(lista);
          continue;
        }
        if (SALIDAS_DEL_NEGOCIO.has(s.tipo)) {
          const seg = "escribiendo" in s ? s.escribiendo : 1;
          if (factor > 0 && seg > 0) {
            setEscribiendo(true);
            await dormir(Math.min(seg * 1000 * factor, 20_000));
            setEscribiendo(false);
            if (token !== tokenRef.current) return;
          }
          agregar({ id: nuevoId(), lado: "negocio", salida: s, hora: horaAhora(), ia });
        } else {
          agregar({ id: nuevoId(), lado: "sistema", salida: s, hora: horaAhora() });
        }
      }
    },
    [agregar, velocidad],
  );

  const aviso = useCallback(
    (a: AvisoIa) => agregar({ id: nuevoId(), lado: "sistema", salida: a, hora: horaAhora() }),
    [agregar],
  );

  /** Respuesta de la IA cuando el flujo no se quedó con el mensaje. */
  const respuestaIa = useCallback(
    async (e: SimEstado, token: number) => {
      if (!iaTrasFlujo) return aviso({ tipo: "ia", codigo: "ia_omitida" });
      if (e.iaPausada) return aviso({ tipo: "ia", codigo: "ia_pausada" });
      setEscribiendo(true);
      try {
        const res = await fetch("/api/flows/simular/ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modo: "agente", historial: e.historial }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          partes?: string[];
          archivos?: string[];
          etiquetas?: string[];
          botones?: string[];
          handoff?: boolean;
          avisos?: string[];
          error?: string;
        };
        setEscribiendo(false);
        if (token !== tokenRef.current) return;
        if (!res.ok) return aviso({ tipo: "ia", codigo: "ia_error", datos: { error: j.error ?? String(res.status) } });
        for (const a of j.avisos ?? []) {
          if (a === "ia_apagada" || a === "agente_modo") aviso({ tipo: "ia", codigo: a });
        }
        const partes = j.partes ?? [];
        await reproducir(
          partes.map((texto) => ({
            tipo: "texto" as const,
            nodo: "",
            texto,
            escribiendo: Math.min(7, Math.max(1.5, 0.8 + texto.length * 0.033)),
          })),
          token,
          true,
        );
        const extras = [
          ...(j.archivos ?? []).map((a) => `📎 ${a}`),
          ...(j.etiquetas ?? []).map((a) => `🏷 ${a}`),
          ...(j.botones ?? []).map((a) => `🔘 ${a}`),
        ];
        if (extras.length) aviso({ tipo: "ia", codigo: "ia_acciones", datos: { lista: extras.join(" · ") } });
        if (j.handoff) aviso({ tipo: "ia", codigo: "ia_traspaso" });
        const actual = estadoRef.current;
        setEstado({
          ...actual,
          historial: [...actual.historial, ...partes.map((texto) => ({ rol: "negocio" as const, texto }))],
        });
      } catch (err) {
        setEscribiendo(false);
        aviso({ tipo: "ia", codigo: "ia_error", datos: { error: err instanceof Error ? err.message : String(err) } });
      }
    },
    [aviso, iaTrasFlujo, reproducir, setEstado],
  );

  /** Corre un paso del simulador y pinta lo que devuelve. */
  const ejecutar = useCallback(
    async (
      paso: (e: SimEstado, f: SimFlujo, s: SimServicios) => Promise<SimResultado>,
      entrada?: SimEntrada,
    ) => {
      if (ocupado) return;
      setOcupado(true);
      const token = ++tokenRef.current;
      try {
        if (entrada) agregar({ id: nuevoId(), lado: "cliente", entrada, hora: horaAhora() });
        const f = await flujoDelPaso(estadoRef.current);
        const r = await paso(estadoRef.current, f, servicios);
        if (token !== tokenRef.current) return;
        setEstado(r.estado);
        await reproducir(r.salidas, token);
        if (!r.consumido && entrada && token === tokenRef.current) await respuestaIa(r.estado, token);
      } finally {
        if (token === tokenRef.current) {
          setOcupado(false);
          setEscribiendo(false);
        }
      }
    },
    [agregar, flujoDelPaso, ocupado, reproducir, respuestaIa, servicios, setEstado],
  );

  const enviar = (entrada: SimEntrada) => ejecutar((e, f, s) => recibir(e, f, entrada, s), entrada);
  const forzarArranque = () => ejecutar((e, f, s) => arrancar(e, f, s));
  const forzar = (a: SimAccion) => ejecutar((e, f, s) => simAccion(e, f, a, s));

  const reiniciar = () => {
    tokenRef.current += 1;
    const limpio = estadoInicial(flow.id, { name: estadoRef.current.contacto.name });
    estadoRef.current = limpio;
    itemsRef.current = [];
    setEstadoLocal(limpio);
    setItems([]);
    setOcupado(false);
    setEscribiendo(false);
    flujosRef.current.clear();
    sesiones.delete(flow.id);
  };

  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    const lineas = itemsRef.current.flatMap((it) => {
      if (it.lado === "cliente") return [`[${it.hora}] ${t("you")}: ${textoEntrada(it.entrada)}`];
      if (it.lado === "negocio") return [`[${it.hora}] ${it.ia ? "IA" : t("business")}: ${textoSalida(it.salida)}`];
      return [];
    });
    try {
      await navigator.clipboard.writeText(lineas.join("\n"));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Portapapeles bloqueado: no pasa nada.
    }
  };

  const acciones = accionesDisponibles(estado, flujoEditor);
  const actual = estado.actual ? porClave.get(estado.actual) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ---- barra del probador ---- */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[12.5px]">
        <div className="inline-flex gap-0.5 rounded-lg border border-border p-0.5">
          <Segmento activo={modo === "celular"} onClick={() => setModo("celular")}>
            <Smartphone className="h-3.5 w-3.5" /> {t("modePhone")}
          </Segmento>
          <Segmento activo={modo === "recorrido"} onClick={() => setModo("recorrido")}>
            <MessageSquare className="h-3.5 w-3.5" /> {t("modePath")}
          </Segmento>
        </div>
        {modo === "celular" && (
          <>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              {t("speed")}
              <select
                value={velocidad}
                onChange={(e) => setVelocidad(e.target.value as Velocidad)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground"
              >
                <option value="real">{t("speedReal")}</option>
                <option value="rapida">{t("speedFast")}</option>
                <option value="instantanea">{t("speedInstant")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground" title={t("aiAfterHint")}>
              <input type="checkbox" checked={iaTrasFlujo} onChange={(e) => setIaTrasFlujo(e.target.checked)} />
              {t("aiAfter")}
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground" title={t("httpRealHint")}>
              <input type="checkbox" checked={httpReal} onChange={(e) => setHttpReal(e.target.checked)} />
              {t("httpReal")}
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <BotonBarra onClick={copiar} disabled={items.length === 0}>
                <Copy className="h-3.5 w-3.5" /> {copiado ? t("copied") : t("copy")}
              </BotonBarra>
              <BotonBarra onClick={reiniciar}>
                <RotateCcw className="h-3.5 w-3.5" /> {t("restart")}
              </BotonBarra>
            </div>
          </>
        )}
      </div>

      {modo === "recorrido" ? (
        <div className="min-h-0 flex-1">
          <FlowPreview onEdit={onEdit} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 p-4 lg:flex-row lg:items-start lg:justify-center">
            {/* ---- el celular ---- */}
            <Celular
              nombre={state.name || t("business")}
              items={items}
              escribiendo={escribiendo}
              ocupado={ocupado}
              vacio={items.length === 0}
              etiquetas={etiquetas}
              plantillas={plantillas}
              porClave={porClave}
              onEnviar={enviar}
              onAccion={forzar}
              onEdit={onEdit}
            />

            {/* ---- panel del probador ---- */}
            <aside className="w-full max-w-[380px] space-y-3 text-[12.5px]">
              {dirty && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
                  {t("unsaved")}
                </p>
              )}

              <Tarjeta titulo={t("statusTitle")}>
                <p className="font-medium text-foreground">{textoEstado(estado, t)}</p>
                {actual && (
                  <div className="mt-2 flex items-center gap-2">
                    <NodeIconChip type={actual.node_type as NodeType} size={22} iconSize={12} />
                    <span className="truncate text-foreground">{tNodos(`nodes.${actual.node_type}.label`)}</span>
                    <code className="rounded bg-muted px-1 text-[11px] text-muted-foreground">{actual.node_key}</code>
                    <button
                      type="button"
                      onClick={() => onEdit(actual.node_key)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" /> {t("edit")}
                    </button>
                  </div>
                )}
                {acciones.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {acciones.map((a) => (
                      <button
                        key={a}
                        type="button"
                        disabled={ocupado}
                        onClick={() => forzar(a)}
                        className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {t(`actions.${a}`)}
                      </button>
                    ))}
                  </div>
                )}
                {estado.fase !== "activa" && (
                  <div className="mt-3 space-y-2">
                    <p className="text-muted-foreground">{textoDisparador(flujoEditor, t)}</p>
                    <button
                      type="button"
                      disabled={ocupado || !state.entry_node_id}
                      onClick={forzarArranque}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      <Play className="h-3.5 w-3.5" /> {t("startAnyway")}
                    </button>
                  </div>
                )}
              </Tarjeta>

              <Tarjeta titulo={t("contactTitle")}>
                <label className="flex items-center gap-2 text-muted-foreground">
                  {t("contactName")}
                  <input
                    value={estado.contacto.name}
                    onChange={(e) =>
                      setEstado({ ...estado, contacto: { ...estado.contacto, name: e.target.value } })
                    }
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-foreground"
                  />
                </label>
              </Tarjeta>

              <Tarjeta titulo={t("varsTitle")}>
                <Variables vars={estado.vars} vacio={t("noVars")} />
              </Tarjeta>

              <Tarjeta titulo={t("tagsTitle")}>
                {estado.etiquetas.length === 0 ? (
                  <p className="text-muted-foreground">{t("noTags")}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {estado.etiquetas.map((id) => (
                      <span key={id} className="rounded-full bg-muted px-2 py-0.5 text-foreground">
                        {etiquetas.get(id) ?? truncate(id, 14)}
                      </span>
                    ))}
                  </div>
                )}
              </Tarjeta>

              <Tarjeta titulo={t("pathTitle")}>
                {estado.recorrido.length === 0 ? (
                  <p className="text-muted-foreground">{t("noPath")}</p>
                ) : (
                  <ol className="flex flex-wrap items-center gap-1">
                    {estado.recorrido.slice(-40).map((k, i) => {
                      const n = porClave.get(k);
                      return (
                        <li key={`${k}-${i}`} className="flex items-center gap-1">
                          {i > 0 && <span className="text-muted-foreground">→</span>}
                          <button
                            type="button"
                            onClick={() => n && onEdit(k)}
                            title={n ? tNodos(`nodes.${n.node_type}.label`) : k}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted/70"
                          >
                            {k}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Tarjeta>

              <p className="px-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {t("hint")}
              </p>
            </aside>
          </div>
        </div>
      )}
    </div>
  );

  function textoSalida(s: SimSalida): string {
    if (s.tipo === "texto" || s.tipo === "botones" || s.tipo === "lista" || s.tipo === "permiso_llamada") return s.texto;
    if (s.tipo === "medio") return s.pie ? `[${s.medio}] ${s.pie}` : `[${s.medio}]`;
    if (s.tipo === "plantilla") return `[${s.nombre}] ${s.parametros.join(" · ")}`;
    return "";
  }
  function textoEntrada(e: SimEntrada): string {
    if (e.kind === "text") return e.text;
    if (e.kind === "tap") return e.title;
    return e.caption || `[${e.media_type}]`;
  }

}

// ============================================================
// Celular
// ============================================================

function Celular(props: {
  nombre: string;
  items: ItemChat[];
  escribiendo: boolean;
  ocupado: boolean;
  vacio: boolean;
  etiquetas: Map<string, string>;
  plantillas: Map<string, string>;
  porClave: Map<string, BuilderNode>;
  onEnviar: (e: SimEntrada) => void;
  onAccion: (a: SimAccion) => void;
  onEdit: (key: string) => void;
}) {
  const t = useTranslations("Flows.simulator");
  const [texto, setTexto] = useState("");
  const [adjuntar, setAdjuntar] = useState(false);
  const [lista, setLista] = useState<Extract<SimSalida, { tipo: "lista" }> | null>(null);
  const fondo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fondo.current?.scrollTo({ top: fondo.current.scrollHeight, behavior: "smooth" });
  }, [props.items.length, props.escribiendo]);

  const mandar = () => {
    const limpio = texto.trim();
    if (!limpio || props.ocupado) return;
    props.onEnviar({ kind: "text", text: limpio });
    setTexto("");
  };

  const adjunto = (que: "foto" | "valido" | "invalido" | "pdf") => {
    setAdjuntar(false);
    if (que === "foto") props.onEnviar({ kind: "media", media_type: "image", caption: "", comprobante: "no" });
    if (que === "pdf") props.onEnviar({ kind: "media", media_type: "document", caption: "", comprobante: "no" });
    if (que === "valido") props.onEnviar({ kind: "media", media_type: "image", caption: "", comprobante: "valido" });
    if (que === "invalido")
      props.onEnviar({ kind: "media", media_type: "image", caption: "", comprobante: "invalido" });
  };

  const inicial = (props.nombre.trim()[0] ?? "N").toUpperCase();

  return (
    <div
      className="relative shrink-0 rounded-[44px] border-[10px] border-neutral-900 bg-neutral-900 shadow-2xl"
      style={{ width: 380, height: 760 }}
    >
      {/* muesca */}
      <div className="absolute left-1/2 top-1.5 z-20 h-6 w-28 -translate-x-1/2 rounded-full bg-neutral-900" />
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-[34px]"
        // Colores de WhatsApp claro en cualquier tema.
        style={{ background: "#efeae2", color: "#111b21" }}
      >
        {/* barra de estado */}
        <div className="flex h-9 shrink-0 items-end justify-between bg-[#008069] px-6 pb-1 text-[12px] font-semibold text-white">
          <span>9:41</span>
          <span className="tracking-widest">●●● ▮</span>
        </div>
        {/* cabecera del chat */}
        <div className="flex h-14 shrink-0 items-center gap-2 bg-[#008069] px-2 text-white">
          <ArrowLeft className="h-5 w-5" />
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/25 text-[15px] font-semibold">
            {inicial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[15px] font-semibold">{props.nombre}</p>
            <p className="truncate text-[11.5px] text-white/85">
              {props.escribiendo ? t("typing") : t("online")}
            </p>
          </div>
          <Video className="h-5 w-5" />
          <Phone className="ml-3 h-[18px] w-[18px]" />
          <MoreVertical className="ml-2 h-5 w-5" />
        </div>

        {/* conversación */}
        <div
          ref={fondo}
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-3"
          style={{
            backgroundImage: "radial-gradient(rgba(0,0,0,0.045) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div className="mx-auto mb-2 w-fit max-w-[85%] rounded-lg bg-[#ffeecd] px-3 py-1.5 text-center text-[11.5px] text-[#54656f] shadow-sm">
            {t("phoneNotice")}
          </div>
          {props.vacio && (
            <div className="mx-auto mt-10 max-w-[80%] text-center text-[12.5px] text-[#54656f]">{t("emptyHint")}</div>
          )}
          {props.items.map((it) =>
            it.lado === "cliente" ? (
              <BurbujaCliente key={it.id} item={it} />
            ) : it.lado === "negocio" ? (
              <MensajeNegocio
                key={it.id}
                item={it}
                plantillas={props.plantillas}
                ocupado={props.ocupado}
                onEnviar={props.onEnviar}
                onAccion={props.onAccion}
                onLista={setLista}
                onEdit={props.onEdit}
              />
            ) : (
              <FichaSistema key={it.id} salida={it.salida} porClave={props.porClave} etiquetas={props.etiquetas} onEdit={props.onEdit} />
            ),
          )}
          {props.escribiendo && (
            <div className="flex">
              <div className="rounded-lg rounded-tl-none bg-white px-3 py-2 shadow-sm">
                <span className="inline-flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0] [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0] [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          )}
        </div>

        {/* menú de adjuntos */}
        {adjuntar && (
          <div className="absolute bottom-16 left-3 z-10 w-60 overflow-hidden rounded-xl bg-white text-[13px] shadow-xl">
            <OpcionAdjunto onClick={() => adjunto("foto")}>📷 {t("attachPhoto")}</OpcionAdjunto>
            <OpcionAdjunto onClick={() => adjunto("pdf")}>📄 {t("attachDocument")}</OpcionAdjunto>
            <OpcionAdjunto onClick={() => adjunto("valido")}>✅ {t("attachReceiptOk")}</OpcionAdjunto>
            <OpcionAdjunto onClick={() => adjunto("invalido")}>⚠️ {t("attachReceiptBad")}</OpcionAdjunto>
          </div>
        )}

        {/* hoja de la lista */}
        {lista && (
          <HojaLista
            lista={lista}
            onCerrar={() => setLista(null)}
            onElegir={(id, titulo) => {
              setLista(null);
              props.onEnviar({ kind: "tap", reply_id: id, title: titulo });
            }}
          />
        )}

        {/* caja de texto */}
        <div className="flex shrink-0 items-end gap-1.5 px-1.5 pb-3 pt-1.5">
          <div className="flex min-h-[42px] flex-1 items-center gap-2 rounded-3xl bg-white px-3 shadow-sm">
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  mandar();
                }
              }}
              placeholder={t("inputPlaceholder")}
              className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-[#111b21] outline-none placeholder:text-[#8696a0]"
            />
            <button
              type="button"
              aria-label={t("attach")}
              title={t("attach")}
              onClick={() => setAdjuntar((v) => !v)}
              className="text-[#54656f]"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          </div>
          <button
            type="button"
            onClick={mandar}
            disabled={props.ocupado}
            aria-label={t("send")}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white shadow disabled:opacity-60"
          >
            {texto.trim() ? <Send className="h-[18px] w-[18px]" /> : <Mic className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function BurbujaCliente({ item }: { item: Extract<ItemChat, { lado: "cliente" }> }) {
  const t = useTranslations("Flows.simulator");
  const e = item.entrada;
  return (
    <div className="flex justify-end">
      <div className="relative max-w-[80%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-2.5 pb-1 pt-1.5 shadow-sm">
        {e.kind === "media" ? (
          <p className="text-[13.5px]">
            {e.media_type === "image"
              ? e.comprobante === "valido"
                ? `🧾 ${t("receiptOk")}`
                : e.comprobante === "invalido"
                  ? `🧾 ${t("receiptBad")}`
                  : `📷 ${t("photo")}`
              : `📄 ${t("document")}`}
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">
            {e.kind === "text" ? e.text : e.title}
          </p>
        )}
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-[#667781]">
          {item.hora} <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" />
        </p>
        {item.reaccion && (
          <span className="absolute -bottom-3 left-1 rounded-full bg-white px-1 text-[12px] shadow">{item.reaccion}</span>
        )}
      </div>
    </div>
  );
}

function Hora({ hora, ia }: { hora: string; ia?: boolean }) {
  return (
    <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-[#667781]">
      {ia && <Sparkles className="h-3 w-3 text-violet-500" />}
      {hora}
    </p>
  );
}

function MensajeNegocio(props: {
  item: Extract<ItemChat, { lado: "negocio" }>;
  plantillas: Map<string, string>;
  ocupado: boolean;
  onEnviar: (e: SimEntrada) => void;
  onAccion: (a: SimAccion) => void;
  onLista: (l: Extract<SimSalida, { tipo: "lista" }>) => void;
  onEdit: (key: string) => void;
}) {
  const t = useTranslations("Flows.simulator");
  const s = props.item.salida;
  const nodo = "nodo" in s ? s.nodo : "";

  const cuerpo = (contenido: ReactNode, extra?: ReactNode) => (
    <div className="group flex flex-col items-start">
      <div className="relative max-w-[82%] min-w-[90px] rounded-lg rounded-tl-none bg-white px-2.5 pb-1 pt-1.5 shadow-sm">
        {props.item.ia && (
          <p className="mb-0.5 text-[10.5px] font-semibold text-violet-600">{t("aiLabel")}</p>
        )}
        {contenido}
        <Hora hora={props.item.hora} ia={props.item.ia} />
        {nodo && (
          <button
            type="button"
            onClick={() => props.onEdit(nodo)}
            title={t("edit")}
            className="absolute -right-7 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-white/90 text-[#54656f] shadow group-hover:flex"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {extra}
    </div>
  );

  const textoWa = (x: string) => <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">{formatoWa(x)}</p>;

  if (s.tipo === "texto") {
    return cuerpo(
      <>
        {s.cita && (
          <div className="mb-1 rounded border-l-4 border-[#06cf9c] bg-[#f0f2f5] px-2 py-1 text-[12px] text-[#54656f]">
            {truncate(s.cita, 80)}
          </div>
        )}
        {textoWa(s.texto)}
      </>,
    );
  }
  if (s.tipo === "medio") {
    return cuerpo(
      <>
        <Medio s={s} />
        {s.pie && <div className="mt-1">{textoWa(s.pie)}</div>}
      </>,
    );
  }
  if (s.tipo === "plantilla") {
    const cuerpoTpl =
      props.plantillas.get(`${s.nombre}|${s.idioma}`) ??
      [...props.plantillas.entries()].find(([k]) => k.startsWith(`${s.nombre}|`))?.[1];
    const lleno = cuerpoTpl
      ? cuerpoTpl.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => s.parametros[Number(n) - 1] ?? `{{${n}}}`)
      : null;
    return cuerpo(
      <>
        <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#00a884]">
          {t("template", { name: s.nombre })}
        </p>
        {lleno ? textoWa(lleno) : <p className="text-[13px] italic text-[#667781]">{s.parametros.join(" · ") || "—"}</p>}
      </>,
    );
  }
  if (s.tipo === "permiso_llamada") {
    return cuerpo(
      <>
        {textoWa(s.texto)}
        <p className="mt-1 text-[11px] text-[#667781]">📞 {t("callPermission")}</p>
      </>,
      <div className="mt-1 flex w-[82%] max-w-[300px] gap-1">
        <BotonInteractivo disabled={props.ocupado} onClick={() => props.onAccion("permiso_aceptado")}>
          {t("callAllow")}
        </BotonInteractivo>
        <BotonInteractivo disabled={props.ocupado} onClick={() => props.onAccion("permiso_rechazado")}>
          {t("callDeny")}
        </BotonInteractivo>
      </div>,
    );
  }
  if (s.tipo === "botones") {
    return cuerpo(
      <>
        {s.imagen && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.imagen} alt="" className="mb-1.5 max-h-48 w-full rounded-md object-cover" />
        )}
        {s.encabezado && <p className="mb-0.5 text-[14px] font-semibold">{s.encabezado}</p>}
        {textoWa(s.texto)}
        {s.pie && <p className="mt-0.5 text-[12px] text-[#667781]">{s.pie}</p>}
      </>,
      <div className="mt-1 flex w-[82%] max-w-[300px] flex-col gap-1">
        {s.botones.map((b) => (
          <BotonInteractivo
            key={b.id}
            disabled={props.ocupado}
            onClick={() => props.onEnviar({ kind: "tap", reply_id: b.id, title: b.titulo })}
          >
            {b.titulo}
          </BotonInteractivo>
        ))}
      </div>,
    );
  }
  if (s.tipo === "lista") {
    return cuerpo(
      <>
        {s.encabezado && <p className="mb-0.5 text-[14px] font-semibold">{s.encabezado}</p>}
        {textoWa(s.texto)}
        {s.pie && <p className="mt-0.5 text-[12px] text-[#667781]">{s.pie}</p>}
        <button
          type="button"
          disabled={props.ocupado}
          onClick={() => props.onLista(s)}
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 border-t border-[#e9edef] pt-1.5 text-[14px] font-medium text-[#027eb5] disabled:opacity-60"
        >
          <ListIcon className="h-4 w-4" /> {s.boton || t("list")}
        </button>
      </>,
    );
  }
  return null;
}

function Medio({ s }: { s: Extract<SimSalida, { tipo: "medio" }> }) {
  const t = useTranslations("Flows.simulator");
  if (!s.url) return <p className="text-[12px] italic text-[#667781]">{t("noMedia")}</p>;
  if (s.medio === "image" || s.medio === "sticker") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={s.url}
        alt=""
        className={cn("rounded-md object-cover", s.medio === "sticker" ? "h-28 w-28" : "max-h-64 w-full")}
      />
    );
  }
  if (s.medio === "video") {
    return <video src={s.url} controls className="max-h-64 w-full rounded-md bg-black" />;
  }
  if (s.medio === "audio") {
    return <audio src={s.url} controls className="h-10 w-60" />;
  }
  return (
    <a
      href={s.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md bg-[#f0f2f5] px-2.5 py-2 text-[13px]"
    >
      <FileText className="h-6 w-6 shrink-0 text-[#e54242]" />
      <span className="truncate">{s.archivo || decodeURIComponent(s.url.split("/").pop() ?? "archivo")}</span>
    </a>
  );
}

function FichaSistema(props: {
  salida: SimSalida | AvisoIa;
  porClave: Map<string, BuilderNode>;
  etiquetas: Map<string, string>;
  onEdit: (key: string) => void;
}) {
  const t = useTranslations("Flows.simulator");
  const tNodos = useTranslations("Flows.builder");
  const tSummary = useTranslations("Flows.summary");
  const s = props.salida;

  let contenido: ReactNode = null;
  let tono: "normal" | "aviso" | "fin" | "ia" = "normal";
  let nodo: string | undefined;

  if (s.tipo === "ia") {
    tono = s.codigo === "ia_error" || s.codigo === "ia_apagada" || s.codigo === "agente_modo" ? "aviso" : "ia";
    contenido = t(`ai.${s.codigo}`, s.datos ?? {});
  } else if (s.tipo === "efecto") {
    nodo = s.nodo;
    const n = props.porClave.get(s.nodo);
    const resumen = n ? summarizeNode(n, tSummary) : null;
    const etiquetasDelNodo =
      n?.node_type === "set_tag"
        ? ((n.config.tag_ids as string[] | undefined)?.length
            ? (n.config.tag_ids as string[])
            : [n.config.tag_id as string]
          )
            .filter(Boolean)
            .map((id) => props.etiquetas.get(id) ?? id)
            .join(", ")
        : null;
    contenido = (
      <span className="inline-flex items-center gap-1.5">
        <NodeIconChip type={s.node_type as NodeType} size={18} iconSize={10} />
        <span className="font-medium">{tNodos(`nodes.${s.node_type}.label`)}</span>
        {(etiquetasDelNodo || s.detalle || resumen) && (
          <span>· {truncate(etiquetasDelNodo || s.detalle || resumen || "", 60)}</span>
        )}
        <span className="opacity-70">({t("wouldHappen")})</span>
      </span>
    );
  } else if (s.tipo === "evento") {
    nodo = s.nodo;
    const datos = { ...(s.datos ?? {}) } as Record<string, string | number>;
    if (typeof datos.segundos === "number") datos.duracion = duracion(datos.segundos);
    contenido = t(`events.${s.codigo}`, datos);
    if (s.codigo === "fin_error" || s.codigo === "fallback_repregunta" || s.codigo === "no_dispara") tono = "aviso";
    else if (s.codigo.startsWith("fin_") || s.codigo.startsWith("fallback_agotado")) tono = "fin";
  } else {
    return null;
  }

  return (
    <div className="flex justify-center py-0.5">
      <button
        type="button"
        onClick={() => nodo && props.porClave.has(nodo) && props.onEdit(nodo)}
        className={cn(
          "max-w-[90%] rounded-lg px-2.5 py-1 text-center text-[11.5px] leading-snug shadow-sm",
          tono === "normal" && "bg-white/80 text-[#54656f]",
          tono === "aviso" && "bg-[#ffeecd] text-[#7a5a00]",
          tono === "fin" && "bg-[#d1e7ff] text-[#0b4a8b]",
          tono === "ia" && "bg-violet-100 text-violet-800",
          nodo ? "cursor-pointer hover:brightness-95" : "cursor-default",
        )}
      >
        {contenido}
      </button>
    </div>
  );
}

function HojaLista(props: {
  lista: Extract<SimSalida, { tipo: "lista" }>;
  onCerrar: () => void;
  onElegir: (id: string, titulo: string) => void;
}) {
  const t = useTranslations("Flows.simulator");
  const [elegida, setElegida] = useState<{ id: string; titulo: string } | null>(null);
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/40">
      <div className="max-h-[75%] overflow-y-auto rounded-t-2xl bg-white pb-3">
        <div className="flex items-center gap-2 border-b border-[#e9edef] px-4 py-3">
          <button type="button" onClick={props.onCerrar} aria-label="Cerrar">
            <X className="h-5 w-5 text-[#54656f]" />
          </button>
          <p className="flex-1 text-center text-[15px] font-semibold">{props.lista.boton || t("list")}</p>
          <span className="w-5" />
        </div>
        {props.lista.secciones.map((sec, i) => (
          <div key={i} className="px-4 pt-3">
            {sec.titulo && <p className="mb-1 text-[12.5px] font-medium text-[#008069]">{sec.titulo}</p>}
            {sec.filas.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-center gap-3 border-b border-[#f0f2f5] py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px]">{f.titulo}</p>
                  {f.descripcion && <p className="text-[12px] text-[#667781]">{f.descripcion}</p>}
                </div>
                <input
                  type="radio"
                  name="fila"
                  checked={elegida?.id === f.id}
                  onChange={() => setElegida({ id: f.id, titulo: f.titulo })}
                  className="h-4 w-4 accent-[#00a884]"
                />
              </label>
            ))}
          </div>
        ))}
        <div className="px-4 pt-3">
          <button
            type="button"
            disabled={!elegida}
            onClick={() => elegida && props.onElegir(elegida.id, elegida.titulo)}
            className="w-full rounded-full bg-[#00a884] py-2.5 text-[14px] font-semibold text-white disabled:opacity-40"
          >
            {t("listSend")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Piezas pequeñas
// ============================================================

/** *negrita*, _cursiva_ y ~tachado~ de WhatsApp. */
function formatoWa(texto: string): ReactNode[] {
  const partes = texto.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return partes.map((p, i) => {
    if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    return <span key={i}>{p}</span>;
  });
}

function BotonInteractivo(props: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="w-full rounded-lg bg-white px-3 py-2 text-center text-[14px] font-medium text-[#027eb5] shadow-sm transition-colors hover:bg-[#f5f6f6] disabled:opacity-60"
    >
      {props.children}
    </button>
  );
}

function OpcionAdjunto(props: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="block w-full px-4 py-2.5 text-left text-[#111b21] hover:bg-[#f5f6f6]"
    >
      {props.children}
    </button>
  );
}

function Segmento(props: { activo: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
        props.activo ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function BotonBarra(props: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-muted disabled:opacity-50"
    >
      {props.children}
    </button>
  );
}

function Tarjeta(props: { titulo: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{props.titulo}</h3>
      {props.children}
    </section>
  );
}

function Variables({ vars, vacio }: { vars: Record<string, unknown>; vacio: string }) {
  const filas = Object.entries(vars).filter(([k]) => !k.startsWith("__"));
  if (filas.length === 0) return <p className="text-muted-foreground">{vacio}</p>;
  return (
    <dl className="space-y-1">
      {filas.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{`{{vars.${k}}}`}</dt>
          <dd className="min-w-0 flex-1 truncate text-foreground" title={String(v)}>
            {String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type T = ReturnType<typeof useTranslations>;

function textoEstado(e: SimEstado, t: T): string {
  if (e.fase === "sin_iniciar") return t("statusIdle");
  if (e.fase === "terminada") return t("statusEnded", { motivo: e.fin?.motivo ?? "—" });
  const w = e.espera;
  if (!w) return t("statusRunning");
  if (w.tipo === "tiempo") return t("wait.tiempo", { duracion: duracion(w.segundos) });
  if (w.tipo === "buffer") return t("wait.buffer", { duracion: duracion(w.segundos), n: w.textos.length });
  if (w.tipo === "respuesta" && w.tiempo && !w.indefinido) {
    return t("wait.respuestaConTiempo", { duracion: duracion(w.tiempo) });
  }
  return t(`wait.${w.tipo}`);
}

function textoDisparador(f: SimFlujo, t: T): string {
  if (f.trigger_type === "keyword") {
    const cfg = f.trigger_config as unknown as KeywordTriggerConfig;
    return t("triggerKeyword", { keywords: (cfg.keywords ?? []).filter(Boolean).join(", ") || "—" });
  }
  if (f.trigger_type === "first_inbound_message") return t("triggerFirst");
  if (f.trigger_type === "any_message") return t("triggerAny");
  return t("triggerManual");
}
