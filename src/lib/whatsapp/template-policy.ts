/**
 * Política de plantillas (Commerce Policy) como ADVERTENCIA.
 *
 * No bloquea el envío: Meta tiene la última palabra y una lista rígida
 * genera falsos positivos (p. ej. una farmacia que envía UTILITY con
 * «medicamento»). El CRM avisa, sugiere y deja decidir al humano.
 */

import type { TemplatePayload } from "./template-validators";

export interface AvisoPolitica {
  code: "commerce_term" | "marketing_without_opt_out";
  term?: string;
  category?: string;
}

const TERMINOS: Array<{ category: string; terms: string[] }> = [
  {
    category: "armas",
    terms: ["arma", "armas", "pistola", "pistolas", "rifle", "rifles", "municion", "municiones", "explosivo", "explosivos", "bomba", "bombas"],
  },
  {
    category: "drogas",
    terms: ["cocaina", "heroina", "metanfetamina", "droga", "drogas"],
  },
  {
    category: "tabaco",
    terms: ["cigarro", "cigarros", "tabaco", "vape", "vapeo", "nicotina"],
  },
  {
    category: "adulto",
    terms: ["pornografia", "escort", "contenido adulto", "sexo explicito"],
  },
  {
    category: "apuestas",
    terms: ["casino", "apuesta", "apuestas", "loteria", "tragamonedas"],
  },
  {
    category: "falsificados",
    terms: ["falsificado", "replica", "imitacion de marca", "copia de marca"],
  },
  {
    category: "especies",
    terms: ["marfil", "especie protegida", "animal exotico"],
  },
];

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function contieneTermino(texto: string, termino: string): boolean {
  const t = normalizar(texto);
  const term = normalizar(termino);
  return new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t);
}

export function tieneBotonBaja(
  buttons: TemplatePayload["buttons"] | undefined,
): boolean {
  if (!buttons?.length) return false;
  return buttons.some((b) => {
    const text = b.text ?? "";
    const id = (b as { id?: string }).id ?? "";
    return (
      b.type === "QUICK_REPLY" &&
      /dejar de recibir|darse de baja|baja|stop|unsubscribe/i.test(`${text} ${id}`)
    );
  });
}

/** Devuelve avisos; nunca lanza. */
export function analizarPlantilla(payload: TemplatePayload): AvisoPolitica[] {
  const avisos: AvisoPolitica[] = [];
  const texto = [
    payload.header_content,
    payload.body_text,
    payload.footer_text,
    ...(payload.buttons ?? []).map((b) => b.text),
  ]
    .filter(Boolean)
    .join("\n");

  for (const grupo of TERMINOS) {
    for (const term of grupo.terms) {
      if (contieneTermino(texto, term)) {
        avisos.push({ code: "commerce_term", term, category: grupo.category });
        break;
      }
    }
  }

  if (payload.category === "Marketing" && !tieneBotonBaja(payload.buttons)) {
    avisos.push({ code: "marketing_without_opt_out" });
  }

  return avisos;
}
