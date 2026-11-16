"use client";

/**
 * Barra de herramientas del editor de flujos (columna izquierda).
 *
 * Arriba, los accesos rápidos que más se usan —texto, imagen, vídeo,
 * documento y voz— porque son el 90 % de un embudo de WhatsApp: un
 * clic añade el paso y el editor lo abre.
 *
 * Abajo, el resto de pasos (botones, lista, preguntar, condición,
 * etiqueta, pasa a agente, fin) agrupados como en los demás menús del
 * editor, para no tener dos catálogos distintos.
 */

import {
  FileText,
  Image as ImageIcon,
  Mic,
  MessageSquarePlus,
  Video,
} from "lucide-react";

import { useFlowEditor } from "./flow-editor-state";
import {
  NODE_META,
  NodeIconChip,
  groupNodeTypesByCategory,
  type NodeType,
} from "./shared";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

interface Acceso {
  clave: string;
  tipo: NodeType;
  /** Solo para los nodos de archivo: fija el tipo de medio al crear. */
  medio?: "image" | "video" | "document" | "audio";
  icon: typeof ImageIcon;
}

const ACCESOS: Acceso[] = [
  { clave: "paletteText", tipo: "send_message", icon: MessageSquarePlus },
  { clave: "paletteImage", tipo: "send_media", medio: "image", icon: ImageIcon },
  { clave: "paletteVideo", tipo: "send_media", medio: "video", icon: Video },
  { clave: "paletteDocument", tipo: "send_media", medio: "document", icon: FileText },
  { clave: "paletteAudio", tipo: "send_media", medio: "audio", icon: Mic },
];

export function FlowPalette({ className }: { className?: string }) {
  const t = useTranslations("Flows.builder");
  const { addNode, updateNodeConfig, requestFlash } = useFlowEditor();

  const agregar = (tipo: NodeType, medio?: Acceso["medio"]) => {
    const key = addNode(tipo);
    // El nodo de archivo nace como imagen; si el atajo pedía otro
    // medio, se ajusta antes de que el usuario lo abra.
    if (medio) updateNodeConfig(key, { media_type: medio });
    requestFlash(key);
  };

  const resto = groupNodeTypesByCategory(
    (Object.keys(NODE_META) as NodeType[]).filter((n) => n !== "start" && n !== "send_media"),
  );

  return (
    <aside
      className={cn(
        "flex flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-3",
        className,
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("paletteTitle")}
      </p>

      <div className="grid gap-1.5">
        {ACCESOS.map((a) => {
          const Icono = a.icon;
          return (
            <button
              key={a.clave}
              type="button"
              onClick={() => agregar(a.tipo, a.medio)}
              className="flex items-center gap-2 rounded-lg border border-border bg-card-2 px-2.5 py-2 text-left text-[12.5px] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icono className="h-3.5 w-3.5" />
              </span>
              {t(a.clave)}
            </button>
          );
        })}
      </div>

      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("paletteAll")}
      </p>

      <div className="grid gap-2">
        {resto.map((grupo) => (
          <div key={grupo.id} className="grid gap-1">
            {grupo.types.map((tipo) => (
              <button
                key={tipo}
                type="button"
                onClick={() => agregar(tipo)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <NodeIconChip type={tipo} size={22} iconSize={13} />
                {t(`nodes.${tipo}.label`)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
