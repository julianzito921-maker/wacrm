/**
 * Fichas de variables ({{contact.name}}, {{custom.campo}}, {{vars.x}}) y
 * variables de plantillas. Funciones puras, sin dependencias: las usa el
 * motor en el servidor y el formulario del editor en el navegador.
 */

// ============================================================
// Fichas de variables: {{contact.name}}, {{custom.campo}}, {{vars.x}}
// ============================================================

export interface DatosFichas {
  contacto: Record<string, unknown>;
  personalizados: Record<string, string>;
  vars: Record<string, unknown>;
}

/** Campos del contacto que se pueden usar en una plantilla o un título. */
export const CAMPOS_CONTACTO = ["name", "phone", "email", "company"] as const;

const FICHA = /\{\{\s*(contact|custom|vars)\.([\w.-]+)\s*\}\}/g;

/** Sustituye las fichas por su valor (vacío si no existe). Pura. */
export function sustituirFichas(texto: string, datos: DatosFichas): string {
  return texto.replace(FICHA, (_m, origen: string, clave: string) => {
    const valor =
      origen === "contact"
        ? datos.contacto[clave]
        : origen === "custom"
          ? datos.personalizados[clave]
          : datos.vars[clave];
    return valor === undefined || valor === null ? "" : String(valor);
  });
}

// ============================================================
// Template WhatsApp
// ============================================================

/**
 * Valores de {{1}}, {{2}}… en orden NUMÉRICO (no alfabético: «10» va
 * después de «9»). Mismo criterio que el paso send_template de las
 * automatizaciones. Pura.
 */
export function parametrosDePlantilla(
  variables: Record<string, string> | undefined,
  datos: DatosFichas,
): string[] {
  if (!variables) return [];
  return Object.keys(variables)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => sustituirFichas(variables[k] ?? "", datos));
}

/** Cuántas variables {{n}} usa el cuerpo de una plantilla. Pura. */
export function variablesDelCuerpo(cuerpo: string): string[] {
  const nums = new Set<number>();
  for (const m of cuerpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b).map(String);
}
