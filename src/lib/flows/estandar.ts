/**
 * Flujos estándar por conexión de WhatsApp, igual que Leona
 * (Configuración → Flujos estándar). Se guardan en
 * `whatsapp_connections.standard_flows`:
 *
 *   - Palabras clave: tienen prioridad sobre todo lo demás. Cada una lleva
 *     a un flujo cuando TODAS sus condiciones se cumplen (es igual,
 *     contiene, es distinto, no contiene, empieza con, termina con).
 *   - Bienvenida: contactos nuevos, en su primer mensaje.
 *   - Conversación finalizada: el cliente vuelve a escribir en una
 *     conversación ya marcada como completada.
 *   - Respuesta predeterminada: ninguna palabra clave coincidió; se
 *     dispara una vez por contacto cada N horas de inactividad.
 *   - Atención finalizada: al marcar la atención como completada.
 *
 * Si la conexión no tiene flujos estándar, el motor sigue usando los
 * disparadores de cada flujo (palabra clave / primer mensaje / cualquiera).
 */

export const OPERADORES_PALABRA = [
  'equals',
  'contains',
  'not_equals',
  'not_contains',
  'starts_with',
  'ends_with',
] as const;
export type OperadorPalabra = (typeof OPERADORES_PALABRA)[number];

export interface CondicionPalabra {
  operator: OperadorPalabra;
  value: string;
}

export interface PalabraClave {
  flow_id: string;
  conditions: CondicionPalabra[];
}

export interface FlujosEstandar {
  welcome_flow_id?: string | null;
  reopened_flow_id?: string | null;
  default_reply_flow_id?: string | null;
  default_reply_hours?: number;
  attendance_finished_flow_id?: string | null;
  keywords?: PalabraClave[];
}

export const HORAS_PREDETERMINADA = 24;

const idValido = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

/** Limpia lo que llega (de la BD o del formulario). */
export function normalizarFlujosEstandar(raw: unknown): FlujosEstandar {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const horas = Number(r.default_reply_hours);
  const keywords = (Array.isArray(r.keywords) ? r.keywords : [])
    .map((k) => {
      const o = (k ?? {}) as Record<string, unknown>;
      const flow = idValido(o.flow_id);
      const conds = (Array.isArray(o.conditions) ? o.conditions : [])
        .map((c) => {
          const cc = (c ?? {}) as Record<string, unknown>;
          const op = OPERADORES_PALABRA.includes(cc.operator as OperadorPalabra)
            ? (cc.operator as OperadorPalabra)
            : 'contains';
          const value = typeof cc.value === 'string' ? cc.value.trim().slice(0, 200) : '';
          return { operator: op, value };
        })
        .filter((c) => c.value);
      return flow && conds.length ? { flow_id: flow, conditions: conds } : null;
    })
    .filter((k): k is PalabraClave => k !== null)
    .slice(0, 50);
  return {
    welcome_flow_id: idValido(r.welcome_flow_id),
    reopened_flow_id: idValido(r.reopened_flow_id),
    default_reply_flow_id: idValido(r.default_reply_flow_id),
    default_reply_hours:
      Number.isFinite(horas) && horas >= 0 ? Math.min(Math.round(horas), 24 * 30) : HORAS_PREDETERMINADA,
    attendance_finished_flow_id: idValido(r.attendance_finished_flow_id),
    keywords,
  };
}

/** Sin acentos, minúsculas y espacios simples. */
function plano(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cumpleCondicion(texto: string, c: CondicionPalabra): boolean {
  const t = plano(texto);
  const v = plano(c.value);
  if (!v) return false;
  switch (c.operator) {
    case 'equals':
      return t === v;
    case 'not_equals':
      return t !== v;
    case 'contains':
      return t.includes(v);
    case 'not_contains':
      return !t.includes(v);
    case 'starts_with':
      return t.startsWith(v);
    case 'ends_with':
      return t.endsWith(v);
  }
}

/** Primera palabra clave cuyas condiciones se cumplen TODAS. */
export function flujoPorPalabraClave(cfg: FlujosEstandar, textos: string[]): string | null {
  for (const k of cfg.keywords ?? []) {
    if (textos.some((t) => k.conditions.every((c) => cumpleCondicion(t, c)))) return k.flow_id;
  }
  return null;
}

export type MotivoEstandar = 'keyword' | 'welcome' | 'reopened' | 'default_reply';

/**
 * Orden de Leona: palabras clave → bienvenida (contacto nuevo) →
 * conversación finalizada (reabierta) → respuesta predeterminada.
 * La espera de la predeterminada la revisa el motor (necesita la BD).
 */
export function candidatosEstandar(
  cfg: FlujosEstandar,
  args: { textos: string[]; primerMensaje: boolean; reabierta: boolean },
): Array<{ flowId: string; motivo: MotivoEstandar }> {
  const out: Array<{ flowId: string; motivo: MotivoEstandar }> = [];
  const palabra = flujoPorPalabraClave(cfg, args.textos);
  if (palabra) out.push({ flowId: palabra, motivo: 'keyword' });
  if (args.primerMensaje && cfg.welcome_flow_id) out.push({ flowId: cfg.welcome_flow_id, motivo: 'welcome' });
  if (args.reabierta && cfg.reopened_flow_id) out.push({ flowId: cfg.reopened_flow_id, motivo: 'reopened' });
  if (cfg.default_reply_flow_id) out.push({ flowId: cfg.default_reply_flow_id, motivo: 'default_reply' });
  return out;
}

/** ¿Tiene la conexión algún flujo estándar configurado? */
export function tieneFlujosEstandar(cfg: FlujosEstandar): boolean {
  return Boolean(
    cfg.welcome_flow_id ||
      cfg.reopened_flow_id ||
      cfg.default_reply_flow_id ||
      cfg.attendance_finished_flow_id ||
      (cfg.keywords ?? []).length,
  );
}
