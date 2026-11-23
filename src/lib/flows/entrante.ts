/**
 * Cómo ve el Flow Builder un mensaje entrante de WhatsApp.
 *
 * Desde la migración 079 las imágenes y los documentos llegan como
 * `media` (con su id y su tipo), para que el nodo Botón Pago / SPEI pueda
 * leer el comprobante. Para cualquier otro nodo el motor los trata igual
 * que antes: como texto con su pie de foto.
 */

import type { ParsedInbound } from "./types";

interface MensajeMeta {
  id: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string };
}

export function mensajeParaFlujo(
  message: MensajeMeta,
  interactiveReplyId: string | null | undefined,
  contentText: string | null | undefined,
): ParsedInbound {
  if (interactiveReplyId) {
    return {
      kind: "interactive_reply",
      reply_id: interactiveReplyId,
      reply_title: contentText ?? "",
      meta_message_id: message.id,
    };
  }
  const medio =
    message.type === "image" ? message.image : message.type === "document" ? message.document : undefined;
  if (medio?.id) {
    return {
      kind: "media",
      media_type: message.type as "image" | "document",
      media_id: medio.id,
      mime_type: medio.mime_type ?? "",
      text: contentText ?? "",
      meta_message_id: message.id,
    };
  }
  return {
    kind: "text",
    text: contentText ?? message.text?.body ?? "",
    meta_message_id: message.id,
  };
}
