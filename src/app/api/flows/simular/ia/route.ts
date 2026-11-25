import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { configIaDeBloque } from "@/lib/flows/engine";
import { parsearSalidaIa, promptSistemaBloqueIa } from "@/lib/flows/bloques-avanzados";
import { interpolateVars } from "@/lib/flows/respuestas";
import type { AiBlockNodeConfig } from "@/lib/flows/types";
import { loadAiConfig } from "@/lib/ai/config";
import { generateReply } from "@/lib/ai/generate";
import { agenteSiempreActivo, aiContextMessageLimit, RESPALDO_SIEMPRE_ACTIVO } from "@/lib/ai/defaults";
import { maxPartes, promptAutoRespuesta, splitReplyParts } from "@/lib/ai/auto-reply";
import { separarAcciones } from "@/lib/ai/acciones";
import { separarArchivos } from "@/lib/ai/archivos";
import { AiError, type ChatMessage } from "@/lib/ai/types";
import { agenteActivo } from "@/lib/agente/responder";
import { temasEn, type Memoria } from "@/lib/messaging/intencion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Turno {
  rol: "cliente" | "negocio";
  texto: string;
}

const MAX_TURNOS = 40;
const MAX_LARGO = 4000;

function leerHistorial(valor: unknown): Turno[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .filter(
      (t): t is Turno =>
        !!t &&
        typeof t === "object" &&
        ((t as Turno).rol === "cliente" || (t as Turno).rol === "negocio") &&
        typeof (t as Turno).texto === "string",
    )
    .map((t) => ({ rol: t.rol, texto: t.texto.slice(0, MAX_LARGO) }))
    .slice(-MAX_TURNOS);
}

function aMensajes(historial: Turno[]): ChatMessage[] {
  return historial
    .filter((t) => t.texto.trim())
    .map((t) => ({ role: t.rol === "cliente" ? "user" : "assistant", content: t.texto }));
}

/**
 * POST /api/flows/simular/ia  (agent+)
 *
 * IA del celular de prueba del editor de flujos. NO manda nada a
 * WhatsApp, no escribe en conversaciones ni corridas: solo devuelve lo
 * que la IA contestaría, armada con el MISMO prompt que producción.
 *
 *   - `modo: "bloque"`: un nodo «Bloque de IA» (prompt del nodo + salidas).
 *   - `modo: "agente"`: la respuesta automática que toma el chat cuando el
 *     flujo no se queda con el mensaje (base de conocimiento, catálogo y
 *     guía de la respuesta). Avisa si en producción no contestaría.
 *
 * Gasta tokens de la clave de la cuenta, como el playground de la IA.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole("agent");

    const limite = checkRateLimit(`flow-sim-ia:${userId}`, RATE_LIMITS.aiDraft);
    if (!limite.success) return rateLimitResponse(limite);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const historial = leerHistorial(body.historial);
    const db = supabaseAdmin();

    if (body.modo === "bloque") {
      const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
      const cfg = (body.config ?? {}) as AiBlockNodeConfig;
      const vars =
        body.vars && typeof body.vars === "object" ? (body.vars as Record<string, unknown>) : {};

      // El flujo tiene que ser de la cuenta (su clave de IA puede estar en el flujo).
      const { data: flujo } = await db
        .from("flows")
        .select("id")
        .eq("id", flowId)
        .eq("account_id", accountId)
        .maybeSingle();
      if (!flujo) return NextResponse.json({ error: "flow_not_found" }, { status: 404 });

      const config = await configIaDeBloque(db, accountId, flowId, cfg);
      if (!config) {
        return NextResponse.json({ error: "ai_not_configured", code: "ai_not_configured" }, { status: 400 });
      }

      // Espejo de ejecutarAiBlock (sin leer fotos, audios ni PDF).
      const ventana = Math.min(Math.max(cfg.context_window ?? 10, 5), 20);
      const recientes = historial.slice(-ventana);
      const ultimoCliente = [...recientes].reverse().find((t) => t.rol === "cliente");
      const textoCliente = ultimoCliente?.texto ?? "";
      const mensaje = interpolateVars(cfg.message_template || "{{last_user_message}}", {
        ...vars,
        last_user_message: textoCliente,
      });
      const contexto = aMensajes(recientes);
      if (textoCliente) contexto.pop();
      contexto.push({ role: "user", content: mensaje || "(sin mensaje)" });

      const gen = await generateReply({
        config,
        systemPrompt: promptSistemaBloqueIa(cfg),
        messages: contexto,
      });
      const { respuesta, salida } = parsearSalidaIa(gen.text);
      return NextResponse.json({ respuesta, salida });
    }

    if (body.modo === "agente") {
      const mensajes = aMensajes(historial).slice(-aiContextMessageLimit());
      if (!mensajes.some((m) => m.role === "user")) {
        return NextResponse.json({ error: "empty_history" }, { status: 400 });
      }
      const config = await loadAiConfig(db, accountId, { requireActive: false });
      if (!config) {
        return NextResponse.json({ error: "ai_not_configured", code: "ai_not_configured" }, { status: 400 });
      }

      // Lo ya comunicado se deduce de lo que «mandó» el negocio en la prueba.
      const memoria: Memoria = {};
      for (const t of historial) {
        if (t.rol !== "negocio") continue;
        for (const tema of temasEn(t.texto)) memoria[tema] = true;
      }

      const { systemPrompt } = await promptAutoRespuesta({
        db,
        accountId,
        config,
        messages: mensajes,
        memoria,
      });
      const { text: textoModelo, handoff: traspaso } = await generateReply({
        config,
        systemPrompt,
        messages: mensajes,
      });
      const siempre = agenteSiempreActivo();
      const respaldo = siempre && (traspaso || !textoModelo);
      const texto = respaldo ? RESPALDO_SIEMPRE_ACTIVO : textoModelo;
      const handoff = respaldo ? false : traspaso;

      const acciones = separarAcciones(texto ?? "");
      const totalArchivos = (acciones.texto.match(/\[\[\s*ARCHIVO\s*:/gi) ?? []).length;
      const partes = splitReplyParts(acciones.texto, Math.max(1, maxPartes() - totalArchivos)).map(
        (p) => separarArchivos(p),
      );

      const avisos: string[] = [];
      if (!config.isActive || !config.autoReplyEnabled) avisos.push("ia_apagada");
      if (await agenteActivo()) avisos.push("agente_modo");

      return NextResponse.json({
        partes: partes.map((p) => p.texto).filter((t) => t.trim()),
        archivos: partes.flatMap((p) => p.claves),
        etiquetas: acciones.etiquetas,
        botones: acciones.botones,
        handoff,
        avisos,
      });
    }

    return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
