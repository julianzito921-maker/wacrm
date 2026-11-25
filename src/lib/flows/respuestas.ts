/**
 * Reglas puras del motor de flujos: emparejar respuestas (toques y
 * texto escrito), disparadores por palabra clave, condiciones y
 * variables {{vars.x}}.
 *
 * Viven aparte de `engine.ts` para que el navegador las use tal cual
 * (simulador del editor): la vista previa decide con el MISMO código
 * que producción. Sin dependencias de servidor.
 */

import type {
  ConditionNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
} from "./types";

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------------
// Respuestas ESCRITAS a botones y listas (13-nov-2026): muchas clientas
// no tocan el botón y escriben («sí», «45», «87 kilos», «las dos», «no
// gracias»). Sin esto el embudo se quedaba parado.
// ------------------------------------------------------------

/** Minúsculas, sin acentos, sin emojis ni signos. */
export function normalizarRespuesta(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rango numérico de un título: «Menos de 60 kg», «De 60 a 74 kg», «40 a 49», «90 kg o más», «Más de 20 kg», «Hasta 5 kg». */
export function rangoDeTitulo(titulo: string): [number, number] | null {
  const n = normalizarRespuesta(titulo);
  let m: RegExpMatchArray | null;
  if ((m = n.match(/^menos de (\d+)/))) return [0, Number(m[1]) - 1];
  if ((m = n.match(/^hasta (\d+)/))) return [0, Number(m[1])];
  if ((m = n.match(/^(?:de )?(\d+) (?:a|al) (\d+)/))) return [Number(m[1]), Number(m[2])];
  if ((m = n.match(/^mas de (\d+)/))) return [Number(m[1]) + 1, Infinity];
  if ((m = n.match(/^(\d+)(?: kg| kilos| anos)? o mas/))) return [Number(m[1]), Infinity];
  return null;
}

/**
 * Número que escribió la clienta según lo que se pregunta: en el peso («kg») prefiere el que
 * va con kg/kilos y nunca toma uno con «años»; en la edad, al revés. 1,67 (estatura) no cuenta.
 */
export function numeroEscrito(texto: string, unidad: "kg" | "anos" | null = null): number | null {
  const n = normalizarRespuesta(texto.replace(/(\d)[.,](\d)/g, "$1x$2"));
  const nums = [...n.matchAll(/(?:^|\s)(\d{1,3}) ?(kg|kgs|kilos?|k|anos?)?(?=\s|$)/g)].map((m) => ({
    n: Number(m[1]),
    u: m[2] ? (m[2].startsWith("k") ? "kg" : "anos") : null,
  }));
  const otra = unidad === "kg" ? "anos" : unidad === "anos" ? "kg" : null;
  const conUnidad = unidad ? nums.find((x) => x.u === unidad) : nums.find((x) => x.u);
  if (conUnidad) return conUnidad.n;
  const suelto = nums.find((x) => x.u === null || (otra === null && x.u));
  return suelto ? suelto.n : null;
}

const AFIRMA = /^(si|sip|simon|ok|okey|okay|va|vale|dale|claro|listo|empecemos|empezamos|vamos|de acuerdo|perfecto|lo quiero|quiero|me interesa|confirmo|agregar|agregalo|agregala|ya)\b/;
const NIEGA = /^(no|nop|nel|ahorita no)\b/;

/**
 * Empareja un texto escrito con una opción de un nodo de botones o lista.
 * Devuelve el next_node_key o null (si no hay una opción clara, sigue el
 * fallback normal y contesta la IA).
 */
export function matchTypedReply(
  node: { node_type: string; config: Record<string, unknown> },
  texto: string,
): string | null {
  type Opcion = { title: string; next_node_key: string };
  let opciones: Opcion[] = [];
  if (node.node_type === "send_buttons") {
    opciones = (node.config as unknown as SendButtonsNodeConfig).buttons ?? [];
  } else if (node.node_type === "send_list") {
    opciones = ((node.config as unknown as SendListNodeConfig).sections ?? []).flatMap((s) => s.rows ?? []);
  } else {
    return null;
  }
  if (opciones.length === 0) return null;
  const t = normalizarRespuesta(texto);
  if (!t) return null;

  // 1. Números contra rangos («87 kilos» → «De 75 a 89 kg»).
  const rangos = opciones.map((o) => rangoDeTitulo(o.title));
  if (rangos.some(Boolean)) {
    const titulos = normalizarRespuesta(opciones.map((o) => o.title).join(" "));
    const unidad = /\bkg\b|kilos/.test(titulos) ? "kg" : /\banos\b|\d+ a \d+|\d+ o mas|menos de \d+$/.test(titulos) ? "anos" : null;
    const num = numeroEscrito(texto, unidad);
    if (num !== null) {
      const hits = opciones.filter((_, i) => rangos[i] && num >= rangos[i]![0] && num <= rangos[i]![1]);
      if (hits.length === 1) return hits[0].next_node_key;
    }
  }

  // 2. El texto de una opción («las dos», «hambre», «hinchazon»).
  const porTitulo = opciones.filter((o) => {
    const tt = normalizarRespuesta(o.title);
    if (!tt) return false;
    if (t === tt) return true;
    if (tt.length >= 4 && t.includes(tt)) return true;
    // «hambre» para «El hambre»: palabra clave de 5+ letras de la opción
    return tt.split(" ").some((p) => p.length >= 5 && !["gracias", "quiero"].includes(p) && t.split(" ").includes(p));
  });
  if (porTitulo.length === 1) return porTitulo[0].next_node_key;

  // 3. Sí / no cortos (sin pregunta, hasta 6 palabras).
  if (/[?¿]/.test(texto) || t.split(" ").length > 6) return null;
  if (node.node_type !== "send_buttons") return null;
  if (NIEGA.test(t) && !AFIRMA.test(t)) {
    const no = opciones.filter((o) => normalizarRespuesta(o.title).startsWith("no"));
    return no.length === 1 ? no[0].next_node_key : null;
  }
  if (AFIRMA.test(t)) {
    const si = opciones.filter((o) => {
      const tt = normalizarRespuesta(o.title);
      return !tt.startsWith("no") && !tt.includes("duda");
    });
    return si.length === 1 ? si[0].next_node_key : null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}


/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
export function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
export function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}
