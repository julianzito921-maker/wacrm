// ============================================================
// CICLO DEL AGENTE — Etapa 1
//
// El bucle completo de function calling:
//   contexto + herramientas → DeepSeek → tool_calls → validar →
//   ejecutar → role:tool → DeepSeek → respuesta final de texto.
//
// Dos reglas que hacen esto seguro:
//   1. El modelo solo puede pedir las herramientas de `ESQUEMAS`; lo que
//      no esté ahí, se rechaza con un `role: tool` de error (el modelo se
//      entera y corrige, sin romper la conversación).
//   2. Hay un tope de vueltas: si el modelo se queda pidiendo
//      herramientas, se corta y se devuelve lo último que tenga. Nunca se
//      queda en bucle.
//
// El proveedor y el ejecutor de herramientas entran por parámetro, así el
// ciclo se prueba sin llamar a nadie de verdad.
// ============================================================

import { ESQUEMAS, ejecutarHerramienta, type ContextoHerramientas } from "./herramientas";

/** Máximo de vueltas de herramientas antes de cortar. */
export const MAX_VUELTAS = 4;

export interface MensajeChat {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface RespuestaModelo {
  content?: string | null;
  tool_calls?: MensajeChat["tool_calls"];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type LlamarModelo = (mensajes: MensajeChat[]) => Promise<RespuestaModelo>;

export interface ResultadoCiclo {
  /** Texto final que se le manda a la clienta (puede ir vacío). */
  texto: string;
  /** Herramientas que se ejecutaron, en orden (auditoría). */
  ejecutadas: Array<{ nombre: string; ok: boolean }>;
  vueltas: number;
  usage: { total_tokens: number };
}

export async function correrCiclo(args: {
  mensajes: MensajeChat[];
  llamarModelo: LlamarModelo;
  contexto: ContextoHerramientas;
}): Promise<ResultadoCiclo> {
  const mensajes: MensajeChat[] = [...args.mensajes];
  const ejecutadas: Array<{ nombre: string; ok: boolean }> = [];
  let tokens = 0;
  let vueltas = 0;
  let texto = "";

  while (vueltas < MAX_VUELTAS) {
    vueltas += 1;
    const respuesta = await args.llamarModelo(mensajes);
    tokens += respuesta.usage?.total_tokens ?? 0;

    const llamadas = respuesta.tool_calls ?? [];
    if (llamadas.length === 0) {
      texto = (respuesta.content ?? "").trim();
      break;
    }

    // Se guarda el turno del asistente tal cual (con sus tool_calls) y se
    // responde cada llamada con un mensaje `role: tool`.
    mensajes.push({
      role: "assistant",
      content: respuesta.content ?? null,
      tool_calls: llamadas,
    });

    for (const llamada of llamadas) {
      let argumentos: unknown = {};
      try {
        argumentos = llamada.function.arguments ? JSON.parse(llamada.function.arguments) : {};
      } catch {
        argumentos = {};
      }

      const resultado = await ejecutarHerramienta(
        llamada.function.name,
        argumentos,
        args.contexto,
      );
      ejecutadas.push({ nombre: llamada.function.name, ok: resultado.ok });

      mensajes.push({
        role: "tool",
        tool_call_id: llamada.id,
        content: JSON.stringify(resultado.datos),
      });
    }

    // Si ya no quedan vueltas, se devuelve lo último que haya dicho el
    // modelo en texto para no dejar la conversación muda.
    if (vueltas === MAX_VUELTAS) {
      texto = (respuesta.content ?? "").trim();
    }
  }

  return { texto, ejecutadas, vueltas, usage: { total_tokens: tokens } };
}

export { ESQUEMAS };
