import type { ConditionRule } from './types';

/** Une reglas con Y/O. Puro para poder probarlo sin base de datos. */
export function combinarCondiciones(
  resultados: boolean[],
  logic: 'all' | 'any' = 'all',
): boolean {
  if (resultados.length === 0) return false;
  return logic === 'any' ? resultados.some(Boolean) : resultados.every(Boolean);
}

export interface SalidaIa {
  respuesta: string;
  salida: string | null;
}

/**
 * DeepSeek puede devolver el JSON limpio o dentro de un bloque Markdown.
 * Si no hay JSON válido, todo el texto es la respuesta y no hay salida.
 */
export function parsearSalidaIa(texto: string): SalidaIa {
  const limpio = texto.replace(/```(?:json)?/gi, '').trim();
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio >= 0 && fin > inicio) {
    try {
      const json = JSON.parse(limpio.slice(inicio, fin + 1)) as {
        respuesta?: unknown;
        salida?: unknown;
        route?: unknown;
      };
      return {
        respuesta:
          typeof json.respuesta === 'string'
            ? json.respuesta
            : typeof json.route === 'string'
              ? limpio
              : limpio,
        salida:
          typeof json.salida === 'string'
            ? json.salida
            : typeof json.route === 'string'
              ? json.route
              : null,
      };
    } catch {
      // Sigue el fallback.
    }
  }
  return { respuesta: texto.trim(), salida: null };
}

/** Cadena de transferencias: máximo 5 y sin repetir el destino. */
export function puedeTransferir(
  cadena: unknown,
  targetFlowId: string,
  maximo = 5,
): boolean {
  const previos = Array.isArray(cadena)
    ? cadena.filter((x): x is string => typeof x === 'string')
    : [];
  return previos.length < maximo && !previos.includes(targetFlowId);
}

/** Las reglas viejas (una sola) se normalizan al formato nuevo. */
export function reglasDeCondicion(cfg: {
  rules?: ConditionRule[];
  subject?: ConditionRule['subject'];
  subject_key?: string;
  operator?: ConditionRule['operator'];
  value?: string;
}): ConditionRule[] {
  if (cfg.rules && cfg.rules.length > 0) return cfg.rules;
  if (!cfg.subject || !cfg.subject_key || !cfg.operator) return [];
  return [
    {
      id: 'legacy',
      subject: cfg.subject,
      subject_key: cfg.subject_key,
      operator: cfg.operator,
      value: cfg.value,
    },
  ];
}

/** Conexión de un handle de ai_block a un nodo destino. */
export function aplicarConexionAiBlock(
  cfg: Record<string, unknown>,
  sourceHandle: string,
  targetKey: string,
): Record<string, unknown> | null {
  if (sourceHandle.startsWith('cond:')) {
    const id = sourceHandle.slice('cond:'.length);
    const condiciones = Array.isArray(cfg.conditions)
      ? (cfg.conditions as Array<Record<string, unknown>>)
      : [];
    if (!condiciones.some((c) => c.id === id)) return null;
    return {
      conditions: condiciones.map((c) =>
        c.id === id ? { ...c, next_node_key: targetKey } : c,
      ),
    };
  }
  if (sourceHandle === 'receipt') return { receipt_next: targetKey };
  if (sourceHandle === 'fallback') return { fallback_next: targetKey };
  return null;
}
