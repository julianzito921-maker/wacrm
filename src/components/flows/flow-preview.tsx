"use client";

/**
 * Vista previa del embudo, en formato conversación de WhatsApp.
 *
 * Por qué existe: el lienzo sirve para *editar* la estructura, pero para
 * *entender* un embudo hace falta verlo como lo ve la clienta. Esta vista
 * recorre el flujo desde el nodo de entrada y pinta cada paso como el
 * mensaje que llega al teléfono: la imagen con su texto, los textos, los
 * botones y las etiquetas. Cada tarjeta tiene un botón para saltar al
 * editor de ese nodo.
 */

import { useMemo } from "react";
import { Pencil } from "lucide-react";

import { useFlowEditor } from "./flow-editor-state";
import {
  NodeIconChip,
  nodeColors,
  summarizeNode,
  truncate,
  type BuilderNode,
  type NodeType,
} from "./shared";
import { outgoingSlots } from "@/lib/flows/edges";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const MAX_PASOS = 80;

/** Camino principal: el primer ramal de cada nodo. */
function siguiente(node: BuilderNode): string | null {
  const cfg = node.config as Record<string, unknown>;
  if (node.node_type === "send_buttons") {
    const botones = Array.isArray(cfg.buttons)
      ? (cfg.buttons as Array<{ next_node_key?: string }>)
      : [];
    return botones[0]?.next_node_key ?? null;
  }
  if (node.node_type === "condition") return (cfg.true_next as string) ?? null;
  if (node.node_type === "send_list") {
    const secciones = Array.isArray(cfg.sections)
      ? (cfg.sections as Array<{ rows?: Array<{ next_node_key?: string }> }>)
      : [];
    return secciones[0]?.rows?.[0]?.next_node_key ?? null;
  }
  return (cfg.next_node_key as string) ?? null;
}

function recorrido(nodos: BuilderNode[], entrada: string | null): BuilderNode[] {
  const porClave = new Map(nodos.map((n) => [n.node_key, n]));
  const camino: BuilderNode[] = [];
  const vistos = new Set<string>();
  let actual = entrada;
  while (actual && !vistos.has(actual) && camino.length < MAX_PASOS) {
    const n = porClave.get(actual);
    if (!n) break;
    vistos.add(actual);
    camino.push(n);
    actual = siguiente(n);
  }
  return camino;
}

function Burbuja({ children, tipo }: { children: React.ReactNode; tipo: NodeType }) {
  const c = nodeColors(tipo);
  return (
    <div
      className="rounded-2xl rounded-tl-sm border px-3.5 py-2.5 shadow-sm"
      style={{ borderColor: c.ring, background: c.soft }}
    >
      {children}
    </div>
  );
}

function BotonWa({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center justify-center rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-[12px] font-medium text-emerald-700">
      {label}
    </span>
  );
}

export function FlowPreview({ onEdit }: { onEdit: (key: string) => void }) {
  const t = useTranslations("Flows.builder");
  const { state } = useFlowEditor();

  const camino = useMemo(
    () => recorrido(state.nodes, state.entry_node_id),
    [state.nodes, state.entry_node_id],
  );

  const porClave = useMemo(
    () => new Map(state.nodes.map((n) => [n.node_key, n])),
    [state.nodes],
  );

  if (camino.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t("previewEmpty")}
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto bg-[#efe7db] px-4 py-6"
      // El fondo imita el chat de WhatsApp (claro) en cualquier tema: el
      // texto también tiene que ser el de WhatsApp, no el del modo oscuro.
      style={
        {
          "--foreground": "#111b21",
          "--muted-foreground": "#54656f",
          "--card": "#ffffff",
          "--border": "#d1d7db",
        } as React.CSSProperties
      }
    >
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <p className="text-center text-[11.5px] text-muted-foreground">{t("previewHint")}</p>

        {camino.map((node, i) => {
          const c = nodeColors(node.node_type);
          const cfg = node.config as Record<string, unknown>;
          const slots = outgoingSlots(node);
          const resumen = summarizeNode(node);
          const esRama =
            node.node_type === "send_buttons" ||
            node.node_type === "condition" ||
            node.node_type === "send_list";

          return (
            <article key={node.node_key} className="relative">
              {/* Cabecera del paso */}
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-[11px] font-semibold"
                  style={{ background: c.solid, color: "#fff" }}
                >
                  {i + 1}
                </span>
                <NodeIconChip type={node.node_type} />
                <span className="text-[12px] font-semibold text-foreground">
                  {t(`nodes.${node.node_type}.label`)}
                </span>
                <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                  {node.node_key}
                </span>
                <button
                  type="button"
                  onClick={() => onEdit(node.node_key)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                  {t("previewEdit")}
                </button>
              </div>

              {/* Cuerpo: el mensaje tal cual llega */}
              <div className="ml-8">
                {node.node_type === "send_media" ? (
                  <Burbuja tipo={node.node_type}>
                    {cfg.media_type === "image" && typeof cfg.media_url === "string" && cfg.media_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cfg.media_url}
                        alt=""
                        className="mb-2 max-h-72 w-full rounded-xl object-cover"
                      />
                    ) : (
                      <div className="mb-2 flex items-center gap-2 rounded-xl bg-black/5 px-3 py-2">
                        <span className="text-[13px]">📄</span>
                        <span className="truncate text-[12px] text-foreground">
                          {typeof cfg.filename === "string" && cfg.filename
                            ? cfg.filename
                            : typeof cfg.media_url === "string"
                              ? decodeURIComponent(cfg.media_url.split("/").pop() ?? "")
                              : "archivo"}
                        </span>
                      </div>
                    )}
                    {typeof cfg.caption === "string" && cfg.caption ? (
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                        {cfg.caption}
                      </p>
                    ) : (
                      <p className="text-[11.5px] italic text-muted-foreground">
                        {t("previewNoCaption")}
                      </p>
                    )}
                  </Burbuja>
                ) : node.node_type === "send_buttons" || node.node_type === "send_list" ? (
                  <div className="space-y-2">
                    {(typeof cfg.header_text === "string" && cfg.header_text) ||
                    (typeof cfg.text === "string" && cfg.text) ? (
                      <Burbuja tipo={node.node_type}>
                        {typeof cfg.header_text === "string" && cfg.header_text ? (
                          <p className="mb-1 text-[12px] font-semibold text-foreground">{cfg.header_text}</p>
                        ) : null}
                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                          {typeof cfg.text === "string" ? cfg.text : ""}
                        </p>
                        {typeof cfg.footer_text === "string" && cfg.footer_text ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">{cfg.footer_text}</p>
                        ) : null}
                      </Burbuja>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {slots.map((s) => (
                        <BotonWa key={s.id} label={s.label} />
                      ))}
                    </div>
                  </div>
                ) : node.node_type === "send_message" ? (
                  <Burbuja tipo={node.node_type}>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                      {typeof cfg.text === "string" ? cfg.text : ""}
                    </p>
                  </Burbuja>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-full px-2.5 py-1 text-[11.5px] font-medium"
                      style={{ background: c.soft, color: c.text }}
                    >
                      {t(`nodes.${node.node_type}.label`)}
                    </span>
                    {resumen ? (
                      <span className="text-[12px] text-muted-foreground">{truncate(resumen, 90)}</span>
                    ) : null}
                  </div>
                )}

                {/* A dónde sigue */}
                {!esRama && slots.length === 1 ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    ↓{" "}
                    {(() => {
                      const destino = siguiente(node);
                      const n = destino ? porClave.get(destino) : null;
                      return n
                        ? `${n.node_key}`
                        : t("previewEndOfFlow");
                    })()}
                  </p>
                ) : null}

                {esRama ? (
                  <div className="mt-2 space-y-1.5 border-l-2 border-dashed border-border pl-3">
                    {slots.map((s) => {
                      const destino = ramaDestino(node, s.id);
                      const n = destino ? porClave.get(destino) : null;
                      return (
                        <p key={s.id} className="text-[11.5px] text-muted-foreground">
                          <span className="font-medium text-foreground">{s.label}</span> →{" "}
                          {n ? (
                            <button
                              type="button"
                              onClick={() => onEdit(n.node_key)}
                              className={cn(
                                "rounded px-1 font-mono text-[11px] hover:bg-black/5",
                              )}
                            >
                              {n.node_key}
                            </button>
                          ) : (
                            t("previewEndOfFlow")
                          )}
                        </p>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** Node key al que lleva un ramal concreto (botón, fila o true/false). */
function ramaDestino(node: BuilderNode, slotId: string): string | null {
  const cfg = node.config as Record<string, unknown>;
  if (node.node_type === "condition") {
    return slotId === "true"
      ? ((cfg.true_next as string) ?? null)
      : ((cfg.false_next as string) ?? null);
  }
  if (slotId.startsWith("button:")) {
    const id = slotId.slice("button:".length);
    const botones = Array.isArray(cfg.buttons)
      ? (cfg.buttons as Array<{ reply_id?: string; next_node_key?: string }>)
      : [];
    return botones.find((b) => b.reply_id === id)?.next_node_key ?? null;
  }
  if (slotId.startsWith("row:")) {
    const id = slotId.slice("row:".length);
    const secciones = Array.isArray(cfg.sections)
      ? (cfg.sections as Array<{ rows?: Array<{ reply_id?: string; next_node_key?: string }> }>)
      : [];
    for (const s of secciones) {
      const fila = s.rows?.find((r) => r.reply_id === id);
      if (fila) return fila.next_node_key ?? null;
    }
    return null;
  }
  return (cfg.next_node_key as string) ?? null;
}
