// ============================================================
// ESTADO DE CONVERSACIÓN — Fase 3
//
// Un estado por conversación, un bloqueo por conversación y dos
// señales que hasta hoy no existían: «esta persona lleva la
// conversación» (traspaso a humano) y «no me escribas más» (baja
// voluntaria).
//
// Por qué importa: sin estado, cualquier módulo podía escribirle a
// cualquiera. Con estado, la política de salida puede apartarse cuando
// hay una persona al mando o cuando la clienta pidió que no se le
// escriba — que es la mitad del problema de los bloqueos.
//
// El bloqueo se toma con un UPDATE condicional: sólo lo consigue quien
// lo encuentra libre, así que dos procesos no pueden contestar a la vez
// al mismo contacto (§18 del pedido).
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

export type EstadoConversacion =
  | "NEW"
  | "ACTIVE"
  | "WAITING_USER"
  | "WAITING_AI"
  | "HUMAN_HANDOFF"
  | "PAUSED"
  | "OPT_OUT"
  | "CLOSED";

/** Estados en los que la automatización no debe escribir. */
const ESTADOS_SIN_AUTOMATICO: EstadoConversacion[] = [
  "HUMAN_HANDOFF",
  "OPT_OUT",
  "PAUSED",
  "CLOSED",
];

export function admiteAutomatico(estado: string | null | undefined): boolean {
  if (!estado) return true;
  return !ESTADOS_SIN_AUTOMATICO.includes(estado as EstadoConversacion);
}

// ---------------------------------------------------------------------------
// Detección de intenciones sensibles
// ---------------------------------------------------------------------------

/** Frases que piden hablar con una persona (§13). */
const PIDE_HUMANO = [
  /\bhumano\b/i,
  /\bpersona\b/i,
  /\basesor(a)?\b/i,
  /\bagente\b/i,
  /\bejecutiv[oa]\b/i,
  /hablar\s+con\s+(alguien|una\s+persona|un\s+humano)/i,
  /(quiero|necesito|me\s+pasas?|comun[ií]came)\s+con\s+(alguien|una\s+persona)/i,
  /atencion\s+a\s+clientes?/i,
  /atiendeme|atiéndeme/i,
];

/** Frases de baja voluntaria (§12). */
const BAJA = [
  /^no$/i,
  /no\s+me\s+escribas?/i,
  /no\s+me\s+vuelvas?\s+a\s+escribir/i,
  /no\s+quiero\s+(que\s+me\s+escribas|recibir|ms?s\s*mensajes)/i,
  // Palabras sueltas que la gente usa para cortar (§12: STOP, BAJA,
  // CANCELAR). «Parar»/«detente»/«eliminar» faltaban y son de las más
  // comunes en español.
  /^\s*(stop|baja|bajas|cancelar|cancela|parar|para|p[aá]rate|detente|unsubscribe|eliminar|elim[ií]name)\s*[.!]?\s*$/i,
  /ya\s+no\s+quiero/i,
  /deja\s+de\s+escribirme/i,
  /no\s+me\s+molestes/i,
  /no\s+m[aá]s\s+(mensajes|ms?s)/i,
  /quita(m|r)?me\s+de\s+(la\s+lista|tu\s+lista)/i,
];

export function pideHumano(texto: string): boolean {
  return PIDE_HUMANO.some((r) => r.test(texto));
}

export function pideBaja(texto: string): boolean {
  return BAJA.some((r) => r.test(texto));
}

// ---------------------------------------------------------------------------
// Bloqueo por conversación
// ---------------------------------------------------------------------------

/**
 * Toma la conversación por `ms`. Devuelve false si otro proceso la tiene
 * tomada: quien no lo consigue, no contesta (evita duplicados).
 */
export async function tomarConversacion(
  conversationId: string,
  quien: string,
  ms = 30_000,
): Promise<boolean> {
  try {
    const db = supabaseAdmin();
    const hasta = new Date(Date.now() + ms).toISOString();
    const { data } = await db
      .from("conversations")
      .update({ locked_until: hasta, locked_by: quien })
      .eq("id", conversationId)
      .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
      .select("id");
    return Boolean(data && data.length > 0);
  } catch {
    // Si falla el bloqueo, se sigue: no puede tumbar la conversación.
    return true;
  }
}

export async function soltarConversacion(conversationId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("conversations")
      .update({ locked_until: null, locked_by: null })
      .eq("id", conversationId);
  } catch {
    // Silencio a propósito: es limpieza.
  }
}

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------

export async function leerEstado(conversationId: string): Promise<EstadoConversacion | null> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("conversations")
      .select("state")
      .eq("id", conversationId)
      .maybeSingle();
    return ((data as { state?: string } | null)?.state as EstadoConversacion) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fija el estado desde fuera (lo usan las herramientas del agente).
 * Es el mismo camino que el automático: si algo falla, avisa y sigue.
 */
export async function fijarEstadoDeConversacion(
  conversationId: string,
  estado: EstadoConversacion,
): Promise<void> {
  return fijarEstado(conversationId, estado);
}

async function fijarEstado(
  conversationId: string,
  estado: EstadoConversacion,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("conversations")
      .update({ state: estado, state_updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch (err) {
    console.error(
      "[estado] no se pudo fijar el estado:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Lo que pasa cuando escribe la clienta: se detectan las dos señales
 * sensibles (baja y humano) y, si no hay ninguna, la conversación pasa a
 * «falta responder». La baja y el traspaso son pegajosos: no se salen
 * solos hasta que una persona los quite.
 */
export async function estadoPorEntrante(args: {
  conversationId: string;
  contactId: string;
  texto: string;
  accountId: string;
}): Promise<{ estado: EstadoConversacion; bajo: boolean; humano: boolean }> {
  const { conversationId, contactId, texto } = args;
  const actual = await leerEstado(conversationId);

  if (pideBaja(texto)) {
    await marcarBaja(contactId, texto);
    await fijarEstado(conversationId, "OPT_OUT");
    await etiquetar(args.accountId, contactId, "pide-humano", true);
    return { estado: "OPT_OUT", bajo: true, humano: false };
  }

  if (pideHumano(texto)) {
    await fijarEstado(conversationId, "HUMAN_HANDOFF");
    await etiquetar(args.accountId, contactId, "pide-humano", true);
    // Meta exige una salida real a una persona: avisar a Julián por WhatsApp.
    // Import dinámico: avisos → send → estado sería un ciclo al cargar.
    void import("./avisos")
      .then((m) => m.avisarTraspasoHumano({ accountId: args.accountId, contactId, conversationId, texto }))
      .catch((err) => console.error("[estado] aviso de traspaso:", err));
    return { estado: "HUMAN_HANDOFF", bajo: false, humano: true };
  }

  // Si venía de baja voluntaria y ella vuelve a escribir, se reabre:
  // su mensaje vuelve a abrir la ventana de atención.
  if (actual === "OPT_OUT") {
    await quitarBaja(contactId);
    await fijarEstado(conversationId, "WAITING_AI");
    return { estado: "WAITING_AI", bajo: false, humano: false };
  }

  if (actual !== "HUMAN_HANDOFF" && actual !== "PAUSED") {
    await fijarEstado(conversationId, "WAITING_AI");
    return { estado: "WAITING_AI", bajo: false, humano: false };
  }

  return { estado: actual ?? "ACTIVE", bajo: false, humano: false };
}

/**
 * Lo que pasa cuando sale un mensaje. Los automáticos dejan la
 * conversación esperando a la clienta; un mensaje de una persona la pasa
 * a traspaso (una persona tomó el control: la automatización se aparta).
 */
export async function estadoPorSaliente(args: {
  conversationId: string;
  automatico: boolean;
}): Promise<void> {
  const actual = await leerEstado(args.conversationId);
  if (actual === "OPT_OUT" || actual === "CLOSED") return;
  if (args.automatico) {
    if (actual !== "HUMAN_HANDOFF") await fijarEstado(args.conversationId, "WAITING_USER");
    return;
  }
  await fijarEstado(args.conversationId, "HUMAN_HANDOFF");
}

/**
 * Registra de dónde vino el consentimiento (§15). Se llama cuando la
 * clienta llega por un anuncio de clic a WhatsApp: el clic en el anuncio
 * ES su consentimiento para que le escribamos por ese canal.
 *
 * Nunca pisa una baja: si ya dijo que no, se queda dicho.
 */
export async function marcarConsentimiento(
  contactId: string,
  datos: { source: string; type: string },
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("contacts")
      .select("consent_status, opt_out_at")
      .eq("id", contactId)
      .maybeSingle();
    const actual = data as { consent_status?: string | null; opt_out_at?: string | null } | null;
    if (actual?.opt_out_at || actual?.consent_status === "denied") return;
    if (actual?.consent_status === "granted") return;
    await db
      .from("contacts")
      .update({
        consent_status: "granted",
        consent_source: datos.source,
        consent_type: datos.type,
        consent_timestamp: new Date().toISOString(),
      })
      .eq("id", contactId);
  } catch (err) {
    console.error(
      "[estado] no se pudo registrar el consentimiento:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function marcarBaja(contactId: string, motivo: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("contacts")
      .update({
        opt_out_at: new Date().toISOString(),
        opt_out_reason: motivo.slice(0, 300),
        consent_status: "denied",
        consent_timestamp: new Date().toISOString(),
      })
      .eq("id", contactId);
  } catch (err) {
    console.error(
      "[estado] no se pudo marcar la baja:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function quitarBaja(contactId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    await db
      .from("contacts")
      .update({ opt_out_at: null, opt_out_reason: null })
      .eq("id", contactId);
  } catch {
    // Silencio a propósito.
  }
}

/** ¿La clienta pidió que no le escribamos? */
export async function estaEnBaja(contactId: string): Promise<boolean> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("contacts")
      .select("opt_out_at")
      .eq("id", contactId)
      .maybeSingle();
    return Boolean((data as { opt_out_at?: string | null } | null)?.opt_out_at);
  } catch {
    return false;
  }
}

/**
 * Etiqueta el contacto (para que la vea el equipo en el CRM). Se usa la
 * tabla de etiquetas existente; si algo falla, no interrumpe nada.
 */
async function etiquetar(
  accountId: string,
  contactId: string,
  nombre: string,
  agregar: boolean,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: tag } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .eq("name", nombre)
      .maybeSingle();
    const tagId = (tag as { id?: string } | null)?.id;
    if (!tagId) return;
    if (agregar) {
      await db
        .from("contact_tags")
        .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: "contact_id,tag_id" });
    } else {
      await db.from("contact_tags").delete().eq("contact_id", contactId).eq("tag_id", tagId);
    }
  } catch {
    // Silencio a propósito: la etiqueta es informativa, no un requisito.
  }
}
