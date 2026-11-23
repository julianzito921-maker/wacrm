// ============================================================
// RESPONDEDOR DEL AGENTE — Etapa 2
//
// El camino real: cuando entra un mensaje, si el agente está encendido
// para la cuenta, Melissa lleva la conversación (entiende, decide y usa
// herramientas) en lugar del embudo visual.
//
// Encendido y apagado:
//   - `messaging_flags.agente_modo` = true  (en caliente, sin desplegar)
//   - o `AGENTE_MODO=on` en el entorno.
// Ambos nacen APAGADOS: hasta que se encienda a propósito, nada cambia.
//
// La respuesta sale por el punto único (`lib/messaging`), así que la
// ventana de 24 h, los límites, la ráfaga, el deduplicado, el opt-out y
// el registro siguen valiendo igual.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { engineSendText } from "@/lib/flows/meta-send";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
import { buildSystemPrompt } from "@/lib/ai/defaults";
import { leerFlag } from "@/lib/messaging/interruptor";
import { leerEstado } from "@/lib/messaging/estado";
import { correrCiclo, type MensajeChat } from "./ciclo";
import { crearLlamador } from "./llamar";

/** ¿Está encendido el agente para esta cuenta? */
export async function agenteActivo(): Promise<boolean> {
  const entorno = (process.env.AGENTE_MODO ?? "").toLowerCase();
  if (["1", "true", "on", "yes"].includes(entorno)) return true;
  return leerFlag("agente_modo", false);
}

export interface ResultadoAgente {
  /** true = el agente se hizo cargo; el webhook no debe seguir con flujos. */
  atendio: boolean;
  motivo?: string;
  texto?: string;
  ejecutadas?: Array<{ nombre: string; ok: boolean }>;
}

/**
 * Corre a Melissa para este mensaje. NUNCA lanza: si algo falla, devuelve
 * `atendio: false` para que el camino de siempre (el embudo) siga
 * funcionando. Es la red de seguridad: el agente no puede dejar la
 * conversación muda por un error suyo.
 */
export async function responderConAgente(args: {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  /** Id de Meta del mensaje entrante (clave de idempotencia). */
  metaMessageId?: string | null;
}): Promise<ResultadoAgente> {
  try {
    if (!(await agenteActivo())) return { atendio: false, motivo: "agente apagado" };

    // Si la conversación la lleva una persona o la clienta pidió no recibir
    // mensajes, el agente se calla (el estado lo manda).
    const estado = await leerEstado(args.conversationId);
    if (estado === "HUMAN_HANDOFF" || estado === "OPT_OUT" || estado === "PAUSED") {
      return { atendio: true, motivo: `estado ${estado}: el agente no escribe` };
    }

    const config = await loadAiConfig(supabaseAdmin(), args.accountId);
    if (!config || !config.isActive || !config.autoReplyEnabled) {
      return { atendio: false, motivo: "IA apagada en la cuenta" };
    }

    const historial = await buildConversationContext(
      supabaseAdmin(),
      args.conversationId,
    );
    if (historial.length === 0) return { atendio: false, motivo: "sin historial" };

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: "auto_reply",
    });

    const mensajes: MensajeChat[] = [
      { role: "system", content: systemPrompt },
      ...historial.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const resultado = await correrCiclo({
      mensajes,
      llamarModelo: crearLlamador(config),
      contexto: {
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        idempotencyKey: args.metaMessageId ? `agente:${args.metaMessageId}` : null,
      },
    });

    console.log(
      `[agente] ${resultado.vueltas} vuelta(s) · herramientas: ${
        resultado.ejecutadas.map((e) => `${e.nombre}${e.ok ? "" : "(falló)"}`).join(", ") || "ninguna"
      } · ${resultado.usage.total_tokens} tokens`,
    );

    // Solo se manda si hay algo que decir. Si el agente terminó ejecutando
    // herramientas sin texto (p. ej. traspaso), no se inventa un mensaje.
    const texto = resultado.texto.trim();
    if (texto) {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: texto,
        reason: "respuesta del agente",
        idempotencyKey: args.metaMessageId ? `agente:${args.metaMessageId}:salida` : null,
      });
    }

    return {
      atendio: true,
      texto,
      ejecutadas: resultado.ejecutadas,
    };
  } catch (err) {
    console.error(
      "[agente] falló y sigue el camino de siempre:",
      err instanceof Error ? err.message : err,
    );
    return { atendio: false, motivo: "error del agente" };
  }
}
