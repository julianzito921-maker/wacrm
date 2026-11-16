// ============================================================
// INTENCIÓN DEL MENSAJE — Fase 5
//
// La IA propone; la capa autoriza. Para que la propuesta sea la
// adecuada, primero se mira QUÉ preguntó la clienta — de forma
// determinista, sin gastar modelo — y qué se le ha dicho ya.
//
// Con eso la respuesta:
//   - contesta exactamente lo preguntado (§6),
//   - no repite lo que ya se comunicó (§11),
//   - es breve y deja la conversación esperando al usuario (§5),
//   - pide humano cuando toca (§13).
//
// No es «variar por variar»: la variación sale del contexto, no de
// esquivar detección (§7 y §26).
// ============================================================

import { pideHumano } from "./estado";

export type Intencion =
  | "PRICE_REQUEST"
  | "CONTENT"
  | "BONUSES"
  | "PAYMENT"
  | "DELIVERY"
  | "BUY"
  | "OBJECTION"
  | "HUMAN"
  | "OPT_OUT"
  | "GREETING"
  | "OTHER";

/** Temas que la conversación puede haber tratado ya (§11). */
export type Tema = "precio" | "contenido" | "bonos" | "pago" | "entrega";

export const TEMAS: Tema[] = ["precio", "contenido", "bonos", "pago", "entrega"];

/** Marcadores por tema: se buscan tanto en lo que escribió la clienta
 *  como en lo que ya se le mandó (memoria). */
const MARCADORES: Record<Tema, RegExp> = {
  precio: /(\bprecio\b|\bcu[aá]nto\b|\bcuesta\b|\baporte\b|\bcosto\b|\$\s?\d)/i,
  contenido: /(\bqu[eé] incluye\b|\bqu[eé] trae\b|\bqu[eé] recib\w*\b|\bcontenido\b|\bpatrones\b|\bdise[nñ]os\b|\bcategor[ií]as\b)/i,
  bonos: /(\bbonos?\b|\bregalos? extra\b|\bplan de\b)/i,
  pago: /(\bclabe\b|\boxxo\b|\btransferencia\b|\bspei\b|\bmercado pago\b|\bcomprobante\b|\bc[oó]mo pago\b|\bdep[oó]sito\b)/i,
  entrega: /(\bpdf\b|\barchivos?\b|\bte (lo )?mando\b|\bte env[ií]o\b|\bdescarg\w+\b|\bya (lo )?recib\w+\b)/i,
};

const BAJA = /(\bno me escribas?\b|^\s*(stop|baja|cancelar)\s*[.!]?\s*$|ya no quiero)/i;

export function temasEn(texto: string): Tema[] {
  return TEMAS.filter((t) => MARCADORES[t].test(texto));
}

/** Intención principal del mensaje de la clienta. */
export function detectarIntencion(texto: string): Intencion {
  const t = texto.trim();
  if (!t) return "OTHER";
  if (BAJA.test(t)) return "OPT_OUT";
  if (pideHumano(t)) return "HUMAN";
  if (MARCADORES.pago.test(t)) return "PAYMENT";
  if (MARCADORES.precio.test(t)) return "PRICE_REQUEST";
  if (MARCADORES.bonos.test(t)) return "BONUSES";
  if (MARCADORES.entrega.test(t)) return "DELIVERY";
  if (/(est[aá] caro|muy caro|no tengo dinero|lo voy a pensar|despu[eé]s|no me interesa|luego)/i.test(t)) {
    return "OBJECTION";
  }
  if (/\b(lo quiero|s[ií],? lo quiero|me lo llevo|quiero el pack|apartalo|ap[aá]rtalo)\b/i.test(t)) {
    return "BUY";
  }
  if (/(^|\s)(hola|buenas|buen d[ií]a|qu[eé] tal)(\s|$)/i.test(t)) return "GREETING";
  if (MARCADORES.contenido.test(t)) return "CONTENT";
  return "OTHER";
}

/** Cómo se le explica la intención al modelo (una línea). */
const COMO_SE_DICE: Record<Intencion, string> = {
  PRICE_REQUEST: "preguntó el precio",
  CONTENT: "preguntó qué incluye el material",
  BONUSES: "preguntó por los bonos",
  PAYMENT: "preguntó cómo se paga",
  DELIVERY: "preguntó cómo recibe el material",
  BUY: "dijo que lo quiere",
  OBJECTION: "puso una objeción o lo va a pensar",
  HUMAN: "pidió hablar con una persona",
  OPT_OUT: "pidió que no se le escriba más",
  GREETING: "solo saludó",
  OTHER: "escribió algo que no encaja en lo anterior",
};

export interface Memoria {
  precio?: boolean;
  contenido?: boolean;
  bonos?: boolean;
  pago?: boolean;
  entrega?: boolean;
}

/**
 * Bloque de guía que se añade al prompt. Es corto a propósito: el modelo
 * ya trae el tono y el producto; esto sólo le dice qué contestar, qué no
 * repetir y cómo terminar.
 */
export function guiaDeRespuesta(args: {
  intencion: Intencion;
  memoria: Memoria;
  temasPreguntados: Tema[];
}): string {
  const { intencion, memoria, temasPreguntados } = args;
  const lineas: string[] = [
    "# GUÍA DE ESTA RESPUESTA (calculada para este mensaje; síguela)",
    `- La clienta ${COMO_SE_DICE[intencion]}.`,
    "- Contesta SOLO eso, en 1 o 2 renglones. Una idea y, como mucho, una pregunta.",
  ];

  const yaDichos = TEMAS.filter((t) => memoria[t]);
  if (yaDichos.length > 0) {
    const pedidos = new Set(temasPreguntados);
    const repetir = yaDichos.filter((t) => pedidos.has(t));
    const callar = yaDichos.filter((t) => !pedidos.has(t));
    if (repetir.length > 0) {
      lineas.push(
        `- Ya se le habló de ${repetir.join(", ")} y lo está volviendo a preguntar: respóndele corto, sin repetir el bloque completo.`,
      );
    }
    if (callar.length > 0) {
      lineas.push(
        `- NO vuelvas a explicar ${callar.join(", ")}: ya se le comunicó. Menciónalo solo si ella lo pide.`,
      );
    }
  }

  if (intencion === "OBJECTION") {
    lineas.push(
      "- Si lo va a pensar o dice que no, agradece en una línea y NO insistas con otra oferta.",
    );
  }
  if (intencion === "HUMAN") {
    lineas.push("- Pasa la conversación a una persona y despídete con una línea cálida.");
  }
  if (intencion === "OPT_OUT") {
    lineas.push("- Confirma en una línea que no se le volverá a escribir y no ofrezcas nada más.");
  }
  if (intencion === "GREETING" || intencion === "OTHER") {
    lineas.push("- No sueltes el discurso completo: saluda y pregunta en qué le ayudas.");
  }
  lineas.push(
    "- Termina dejando que ella sea la que sigue: no adelantes el siguiente paso por tu cuenta.",
  );
  return lineas.join("\n");
}
