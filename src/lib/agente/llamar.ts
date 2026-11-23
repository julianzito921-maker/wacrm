// ============================================================
// LLAMADA AL MODELO CON HERRAMIENTAS — Etapa 2
//
// El proveedor que ya usa el CRM (`lib/ai/providers/openai-compatible`)
// manda texto y recibe texto: no sabe de herramientas. Aquí se añade esa
// capacidad sin tocar nada de lo existente: misma configuración de la
// cuenta (base URL, clave, modelo), mismas protecciones (el mismo filtro
// de hosts privados) y el mismo apagado de razonamiento que ya se usa en
// producción para DeepSeek.
// ============================================================

import { normalizeOpenAiCompatibleBaseUrl } from "@/lib/ai/providers/openai-compatible";
import { aiRequestTimeoutMs, MAX_OUTPUT_TOKENS } from "@/lib/ai/defaults";
import type { AiConfig } from "@/lib/ai/types";
import type { MensajeChat, RespuestaModelo } from "./ciclo";
import { ESQUEMAS } from "./herramientas";

/** Igual que en producción: se apaga el razonamiento si es DeepSeek. */
function pensamientoApagado(baseUrl: string | null | undefined): boolean {
  if (process.env.AI_DEEPSEEK_SIN_PENSAR !== "on") return false;
  try {
    return new URL(baseUrl ?? "").hostname.endsWith("deepseek.com");
  } catch {
    return false;
  }
}

/**
 * Una vuelta contra el modelo, con las herramientas disponibles.
 * Devuelve el texto, las herramientas que pida y el uso de tokens.
 */
export function crearLlamador(config: AiConfig) {
  const base = normalizeOpenAiCompatibleBaseUrl(config.baseUrl ?? "");
  const apagarPensamiento = pensamientoApagado(config.baseUrl);

  return async function llamar(mensajes: MensajeChat[]): Promise<RespuestaModelo> {
    const cuerpo: Record<string, unknown> = {
      model: config.model,
      messages: mensajes,
      tools: ESQUEMAS,
      tool_choice: "auto",
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
    };
    if (apagarPensamiento) cuerpo.thinking = { type: "disabled" };

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), aiRequestTimeoutMs());
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      });
      const texto = await r.text();
      if (!r.ok) {
        throw new Error(`Meta… proveedor ${r.status}: ${texto.slice(0, 300)}`);
      }
      const j = JSON.parse(texto) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: RespuestaModelo["tool_calls"];
          };
        }>;
        usage?: RespuestaModelo["usage"];
      };
      const mensaje = j.choices?.[0]?.message ?? {};
      return {
        content: mensaje.content ?? "",
        tool_calls: mensaje.tool_calls ?? [],
        usage: j.usage,
      };
    } finally {
      clearTimeout(reloj);
    }
  };
}
