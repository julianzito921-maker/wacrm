// ============================================================
// ENTREGA DEL PACK — Etapa 1 (base de la Etapa 3)
//
// La lista de documentos es FIJA y vive aquí, no en el modelo: el agente
// no puede inventar archivos ni cambiar el destinatario. Solo puede pedir
// «entrega el pack», y el servidor decide qué es el pack.
//
// La entrega es idempotente: antes de mandar, se mira el registro de
// salida para ver qué documentos ya salieron y se manda solo lo que
// falta (si un envío falló a medias, no se repiten los que llegaron).
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { engineSendMedia } from "@/lib/flows/meta-send";

const CARPETA = "92d9c5a4-c4c8-4e33-95ee-8e203fe57d76/amigurumis";

export interface DocumentoDelPack {
  clave: "pack" | "bono-abc" | "bono-adornos" | "bono-empaque" | "bono-plan";
  archivo: string;
  /** Nombre que ve la clienta en WhatsApp. */
  etiqueta: string;
}

/** Los cinco archivos, en el orden en que se entregan. */
export const PACK: DocumentoDelPack[] = [
  {
    clave: "pack",
    archivo: "150-Amigurumis-de-Navidad.pdf",
    etiqueta: "Pack · 150 Amigurumis de Navidad",
  },
  {
    clave: "bono-abc",
    archivo: "Bono-1-ABC-del-amigurumi.pdf",
    etiqueta: "Bono 1 · ABC del amigurumi",
  },
  {
    clave: "bono-adornos",
    archivo: "Bono-2-12-adornos-rapidos.pdf",
    etiqueta: "Bono 2 · 12 adornos rápidos",
  },
  {
    clave: "bono-empaque",
    archivo: "Bono-3-Empaca-y-regala.pdf",
    etiqueta: "Bono 3 · Empaca y regala",
  },
  {
    clave: "bono-plan",
    archivo: "Bono-4-Plan-14-dias.pdf",
    etiqueta: "Bono 4 · Plan de 14 días",
  },
];

function urlDe(archivo: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/flow-media/${CARPETA}/${archivo}`;
}

/** ¿Qué documentos ya salieron en esta conversación? */
export async function documentosEntregados(
  conversationId: string,
): Promise<Set<string>> {
  const entregados = new Set<string>();
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("outbound_message_log")
      .select("content_preview, status")
      .eq("conversation_id", conversationId)
      .in("status", ["sent"])
      .limit(200);
    for (const fila of (data as Array<{ content_preview: string | null }> | null) ?? []) {
      const texto = fila.content_preview ?? "";
      for (const doc of PACK) {
        if (texto.includes(doc.archivo) || texto.includes(doc.etiqueta)) {
          entregados.add(doc.clave);
        }
      }
    }
  } catch {
    // Si no se puede leer, se devuelve vacío: la entrega volverá a
    // intentarse y la política/dedupe de la capa de mensajería evita
    // duplicados exactos.
  }
  return entregados;
}

export interface ResultadoEntrega {
  estado: "completa" | "parcial" | "ya_entregada";
  enviados: string[];
  fallidos: Array<{ clave: string; error: string }>;
}

/**
 * Entrega lo que falte del pack. Nunca lanza: devuelve el resultado para
 * que el agente pueda contarlo bien.
 */
export async function entregarPack(args: {
  accountId: string;
  /** Autor de la cuenta: el envío lo guarda para auditoría. */
  userId: string;
  conversationId: string;
  contactId: string;
  /** Clave de idempotencia de la ejecución del agente. */
  idempotencyKey?: string | null;
}): Promise<ResultadoEntrega> {
  const ya = await documentosEntregados(args.conversationId);
  const faltan = PACK.filter((d) => !ya.has(d.clave));

  if (faltan.length === 0) {
    return { estado: "ya_entregada", enviados: [], fallidos: [] };
  }

  const enviados: string[] = [];
  const fallidos: Array<{ clave: string; error: string }> = [];

  for (const doc of faltan) {
    try {
      // Se reutiliza el envoltorio del flujo: ya resuelve el contacto, las
      // credenciales de la cuenta, guarda el mensaje y pasa por la capa
      // segura (ventana, límites, duplicados y registro).
      await engineSendMedia({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        kind: "document",
        link: urlDe(doc.archivo),
        filename: doc.archivo,
        caption: doc.etiqueta,
        reason: `entrega del pack: ${doc.clave}`,
        idempotencyKey: args.idempotencyKey
          ? `${args.idempotencyKey}:${doc.clave}`
          : null,
      });
      enviados.push(doc.clave);
    } catch (err) {
      fallidos.push({
        clave: doc.clave,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    estado: fallidos.length === 0 ? "completa" : "parcial",
    enviados,
    fallidos,
  };
}
