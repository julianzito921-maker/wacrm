/**
 * Lectura del contenido de una exportación .zip de WhatsApp.
 *
 * El descomprimido lo hace el llamador (el diálogo importa `fflate` de
 * forma dinámica); aquí solo se elige el `.txt`, se parsea y se arma el
 * mapa de medios por nombre. Sin DOM ni Supabase: puro y testeable.
 */

import { parseWhatsAppChat, type ParsedChat } from "./whatsapp-chat-parser";

export interface ChatZipMedia {
  /** Nombre del archivo tal cual viene en el .zip. */
  nombre: string;
  bytes: Uint8Array;
  size: number;
}

export type ChatZipErrorCode = "no_txt" | "group_chat" | "one_sided" | "no_messages";

export class ChatZipError extends Error {
  constructor(public readonly code: ChatZipErrorCode) {
    super(code);
    this.name = "ChatZipError";
  }
}

export interface ParsedChatZip {
  /** Ruta del .txt dentro del .zip (para el informe). */
  nombreTxt: string;
  chat: ParsedChat;
  /** nombre en minúsculas → archivo. */
  medios: Map<string, ChatZipMedia>;
  variosTxt: boolean;
}

export function parseChatZipEntries(
  entradas: Record<string, Uint8Array>,
  opciones: { preferDayFirst?: boolean } = {},
): ParsedChatZip {
  const txts = Object.entries(entradas)
    .filter(([ruta]) => /\.txt$/i.test(ruta) && !ruta.includes("__MACOSX"))
    .sort((a, b) => b[1].length - a[1].length);
  if (txts.length === 0) throw new ChatZipError("no_txt");

  const [nombreTxt, bytesTxt] = txts[0];
  const texto = new TextDecoder("utf-8").decode(bytesTxt);
  const chat = parseWhatsAppChat(texto, {
    preferDayFirst: opciones.preferDayFirst ?? true,
  });
  if (chat.messages.length === 0) throw new ChatZipError("no_messages");
  if (chat.participants.length > 2) throw new ChatZipError("group_chat");
  if (chat.participants.length < 2) throw new ChatZipError("one_sided");

  const medios = new Map<string, ChatZipMedia>();
  for (const [ruta, bytes] of Object.entries(entradas)) {
    if (ruta === nombreTxt || ruta.includes("__MACOSX")) continue;
    const base = ruta.split("/").pop() ?? "";
    if (!base || base.startsWith(".") || /\.txt$/i.test(base)) continue;
    medios.set(base.trim().toLowerCase(), {
      nombre: base,
      bytes,
      size: bytes.length,
    });
  }

  return { nombreTxt, chat, medios, variosTxt: txts.length > 1 };
}
