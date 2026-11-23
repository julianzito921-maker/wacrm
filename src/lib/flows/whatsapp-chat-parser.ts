/**
 * Parser puro del `.txt` que WhatsApp incluye en la exportación de un
 * chat individual. No toca base de datos ni Storage: el diálogo de
 * importación le pasa el texto y los nombres de los medios del .zip.
 *
 * Soporta los dos formatos habituales:
 *   [31/12/24, 21:41:05] Ana: Hola          (Android / export nuevo)
 *   31/12/24, 21:41 - Ana: Hola             (iOS / export viejo)
 * y las variantes con AM/PM, año de 2 o 4 cifras y separador . - /
 *
 * Reglas:
 *   - Las líneas sin marca de fecha son continuación del mensaje anterior
 *     (así se recuperan los pies de foto y los mensajes de varias líneas).
 *   - Las líneas de sistema (cifrado, cambios de grupo, etc.) no son
 *     mensajes y no cuentan como participantes.
 *   - Los medios se reconocen por el nombre del archivo y por los
 *     marcadores de WhatsApp (`<adjunto: …>`, `(archivo adjunto)`,
 *     `<Media omitted>`, `imagen omitida`, …).
 *   - No inventa nada: lo que no se puede clonar se marca para que el
 *     diálogo lo muestre y decida.
 */

export type ChatMediaKind = "image" | "video" | "audio" | "sticker" | "document";

export interface ChatMedia {
  /** Nombre tal cual aparece en el .txt (sin el marcador). */
  filename: string;
  kind: ChatMediaKind;
}

export interface ParsedChatMessage {
  /** Posición 0-based en el chat (solo mensajes reales, sin sistema). */
  index: number;
  at: Date;
  /** Autor tal cual sale en el .txt. */
  author: string | null;
  /** Texto visible. En medios, el pie de foto (sin el marcador). */
  text: string;
  media: ChatMedia | null;
  /** El .txt dice que había un medio pero no vino en el .zip. */
  omitted: boolean;
  /** Tipo que nuestro modelo no sabe representar (ubicación, etc.). */
  unsupported: string | null;
  system: boolean;
}

export interface ChatParticipant {
  name: string;
  count: number;
}

export interface ParseIssue {
  code: "ambiguous_dates" | "unparsed_lines" | "no_messages" | "system_lines";
  /** Datos para el mensaje (p. ej. cuántas líneas). */
  count?: number;
}

export interface ParsedChat {
  participants: ChatParticipant[];
  messages: ParsedChatMessage[];
  /** Formato detectado, solo para el informe. */
  format: "android" | "ios" | "desconocido";
  issues: ParseIssue[];
}

export interface ParseOptions {
  /**
   * Qué hacer cuando la fecha es ambigua (05/06/24): true = día primero.
   * Por defecto sí, que es lo habitual en español y portugués.
   */
  preferDayFirst?: boolean;
}

interface RawMessage {
  /** Los tres números de la fecha, en el orden en que aparecen. */
  a: number;
  b: number;
  c: number;
  hour: number;
  minute: number;
  second: number;
  ampm: "a" | "p" | null;
  rest: string;
}

// Índices de los grupos (sin nombres para mantener el target ES2017):
// 1=a, 2=b, 3=c, 4=오전/오후, 5=hora, 6=minuto, 7=segundo, 8=am/pm, 9=resto
const RE_BRACKET =
  /^\[(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,4})[.,]?\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*\]\s*(.*)$/i;
const RE_DASH =
  /^(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,4})[.,]?\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*[-–—]\s*(.*)$/i;
const RE_DATE_ONLY = /^\d{1,4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,4}[.,]?$/;

/** Marcas invisibles que WhatsApp mete al inicio de líneas de medios. */
function limpiar(linea: string): string {
  return linea
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "");
}

const RE_SISTEMA =
  /cifrad|cifrado extremo a extremo|end-to-end encrypt| cambi[oó] el asunto|changed the subject|a[nñ]adi[oó]|added|sali[oó] del grupo|left|se uni[oó]|joined using|cre[oó] el grupo|created group|cambi[oó] el (?:icono|ícono)|changed this group|n[uú]mero de tel[eé]fono|cambi[oó] su n[uú]mero|now you can call|ahora puedes llamar|este mensaje fue eliminado|this message was deleted|eliminaste este mensaje|you deleted this message/i;

const RE_OMITIDO =
  /^(?:<\s*)?(media|imagen|image|video|audio|sticker|gif|archivo|file|documento|document)\s+(?:omitid[oa]|omitted)(?:\s*>)?$/i;

const RE_NO_SOPORTADO: Array<[RegExp, string]> = [
  [/ubicaci[oó]n omitida|location omitted/i, "ubicacion"],
  [/contacto omitido|contact card omitted/i, "contacto"],
  [/encuesta omitida|poll omitted/i, "encuesta"],
  [/ver una vez|view once/i, "ver_una_vez"],
  [/mensaje (?:fue )?eliminado|this message was deleted|eliminaste este mensaje|you deleted this message/i, "eliminado"],
];

const EXT_KIND: Record<string, ChatMediaKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  heic: "image",
  webp: "sticker",
  mp4: "video",
  mov: "video",
  "3gp": "video",
  opus: "audio",
  ogg: "audio",
  m4a: "audio",
  mp3: "audio",
  aac: "audio",
  amr: "audio",
  wav: "audio",
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  txt: "document",
  csv: "document",
  zip: "document",
  rar: "document",
};

const RE_ADJUNTO_ANGLE = /^<\s*(?:attached|adjunto)\s*:\s*(.+?)\s*>\s*(.*)$/i;
const RE_ADJUNTO_PAREN =
  /^(.+?)\s*\((?:archivo adjunto|file attached|attached|adjunto)\)\s*(.*)$/i;
const RE_ANGLE_FILE = /^<\s*([^<>]+?)\s*>$/i;
const RE_ARCHIVO =
  /([^\\/:*?"<>|\r\n]+\.(?:jpe?g|png|heic|webp|mp4|mov|3gp|opus|ogg|m4a|mp3|aac|amr|wav|pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar))/i;

const RE_AUTOR = /^([^:]{1,120}):\s?([\s\S]*)$/;

function kindDe(nombre: string): ChatMediaKind {
  const ext = nombre.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "document";
}

function esOmitido(texto: string): boolean {
  const primera = texto.split("\n")[0]?.trim() ?? "";
  return RE_OMITIDO.test(primera);
}

function noSoportado(texto: string): string | null {
  for (const [re, tipo] of RE_NO_SOPORTADO) {
    if (re.test(texto)) return tipo;
  }
  return null;
}

/**
 * Primer medio del mensaje y el texto que queda (pie de foto).
 * Solo mira la primera línea: en el export el marcador va al principio.
 */
function extraerMedio(texto: string): {
  media: ChatMedia | null;
  resto: string;
} {
  const lineas = texto.split("\n");
  const primera = (lineas[0] ?? "").trim();
  const restoLineas = lineas.slice(1);

  const angulo = RE_ADJUNTO_ANGLE.exec(primera);
  if (angulo) {
    return {
      media: { filename: angulo[1].trim(), kind: kindDe(angulo[1]) },
      resto: [angulo[2] ?? "", ...restoLineas].join("\n").trim(),
    };
  }

  const parentesis = RE_ADJUNTO_PAREN.exec(primera);
  if (parentesis) {
    return {
      media: { filename: parentesis[1].trim(), kind: kindDe(parentesis[1]) },
      resto: [parentesis[2] ?? "", ...restoLineas].join("\n").trim(),
    };
  }

  // iOS a veces exporta `<IMG_0001.JPG>` sin la palabra attached.
  if (RE_ANGLE_FILE.test(primera)) {
    const interno = primera.replace(/^<\s*|\s*>$/g, "").trim();
    if (RE_ARCHIVO.test(interno)) {
      return {
        media: { filename: interno, kind: kindDe(interno) },
        resto: restoLineas.join("\n").trim(),
      };
    }
  }

  return { media: null, resto: texto };
}

function aFecha(raw: RawMessage, orden: "ymd" | "dmy" | "mdy"): Date {
  let year: number;
  let month: number;
  let day: number;
  if (orden === "ymd") {
    year = raw.a;
    month = raw.b;
    day = raw.c;
  } else if (orden === "dmy") {
    day = raw.a;
    month = raw.b;
    year = raw.c;
  } else {
    month = raw.a;
    day = raw.b;
    year = raw.c;
  }
  if (year < 100) year += year < 70 ? 2000 : 1900;
  let hour = raw.hour;
  if (raw.ampm === "p" && hour < 12) hour += 12;
  if (raw.ampm === "a" && hour === 12) hour = 0;
  return new Date(year, month - 1, day, hour, raw.minute, raw.second);
}

export function parseWhatsAppChat(
  contenido: string,
  opciones: ParseOptions = {},
): ParsedChat {
  const preferDayFirst = opciones.preferDayFirst ?? true;
  const lineas = contenido.replace(/\ufeff/g, "").split(/\r?\n/);
  const issues: ParseIssue[] = [];
  const raws: RawMessage[] = [];
  let formato: ParsedChat["format"] = "desconocido";
  let lineasSueltas = 0;
  let lineasSistema = 0;

  for (const lineaCruda of lineas) {
    const linea = limpiar(lineaCruda);
    if (!linea.trim()) {
      // Línea vacía dentro de un mensaje: se conserva como salto.
      if (raws.length > 0) raws[raws.length - 1].rest += "\n";
      continue;
    }
    if (RE_DATE_ONLY.test(linea.trim())) continue; // separador de fecha (iOS)

    const bracket = RE_BRACKET.exec(linea);
    const dash = bracket ? null : RE_DASH.exec(linea);
    const m = bracket ?? dash;
    if (m) {
      const marca = m[8]?.toLowerCase();
      raws.push({
        a: Number(m[1]),
        b: Number(m[2]),
        c: Number(m[3]),
        hour: Number(m[5]),
        minute: Number(m[6]),
        second: Number(m[7] ?? 0),
        ampm:
          marca === "a" || m[4] === "오전"
            ? "a"
            : marca === "p" || m[4] === "오후"
              ? "p"
              : null,
        rest: m[9] ?? "",
      });
      if (formato === "desconocido") formato = bracket ? "android" : "ios";
      continue;
    }

    // Sin marca de fecha: continuación del mensaje anterior. Si no hay
    // anterior, es una línea suelta (encabezado, etc.).
    if (raws.length > 0) {
      raws[raws.length - 1].rest += `\n${linea}`;
    } else {
      lineasSueltas += 1;
    }
  }

  // Orden de la fecha: año primero si la 1ª cifra tiene 4 dígitos; si no,
  // se decide por valores >12 y, en empate, por preferencia del idioma.
  let orden: "ymd" | "dmy" | "mdy" = "dmy";
  let ambiguo = false;
  if (raws.length > 0) {
    const primero = raws[0];
    if (primero.a > 31) {
      orden = "ymd";
    } else {
      const diaPrimero = raws.some((r) => r.a > 12);
      const mesPrimero = raws.some((r) => r.b > 12);
      if (diaPrimero && !mesPrimero) orden = "dmy";
      else if (mesPrimero && !diaPrimero) orden = "mdy";
      else {
        ambiguo = true;
        orden = preferDayFirst ? "dmy" : "mdy";
      }
    }
  }

  const counts = new Map<string, number>();
  const messages: ParsedChatMessage[] = [];

  for (const raw of raws) {
    const at = aFecha(raw, orden);
    if (Number.isNaN(at.getTime())) continue;

    const rest = raw.rest.replace(/^\s+/, "");
    const autorMatch = RE_AUTOR.exec(rest);
    const esSistema = RE_SISTEMA.test(rest) && !autorMatch;
    if (esSistema) {
      lineasSistema += 1;
      continue;
    }

    if (!autorMatch) {
      // Línea con fecha pero sin "Nombre:": casi siempre sistema.
      lineasSistema += 1;
      continue;
    }

    const author = autorMatch[1].trim();
    let texto = autorMatch[2] ?? "";
    if (!author) {
      lineasSistema += 1;
      continue;
    }

    const { media, resto } = extraerMedio(texto);
    texto = resto.trim();
    const omitted = !media && esOmitido(texto);
    const unsupported = noSoportado(texto);

    counts.set(author, (counts.get(author) ?? 0) + 1);
    messages.push({
      index: messages.length,
      at,
      author,
      text: texto,
      media,
      omitted,
      unsupported,
      system: false,
    });
  }

  if (ambiguo) issues.push({ code: "ambiguous_dates" });
  if (lineasSueltas > 0) {
    issues.push({ code: "unparsed_lines", count: lineasSueltas });
  }
  if (lineasSistema > 0) {
    issues.push({ code: "system_lines", count: lineasSistema });
  }
  if (messages.length === 0) issues.push({ code: "no_messages" });

  const participants: ChatParticipant[] = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { participants, messages, format: formato, issues };
}
