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
  callPermission?: {
    response: "accept" | "reject";
    is_permanent: boolean;
    expiration_timestamp?: number | null;
    context_id?: string | null;
  } | null,
): ParsedInbound {
  if (callPermission) {
    return {
      kind: "call_permission",
      response: callPermission.response,
      is_permanent: callPermission.is_permanent,
      expiration_timestamp: callPermission.expiration_timestamp ?? null,
      context_id: callPermission.context_id ?? null,
      meta_message_id: message.id,
    };
  }
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
