import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, agenteSiempreActivo, RESPALDO_SIEMPRE_ACTIVO } from './defaults'
import { detectarIntencion, guiaDeRespuesta, temasEn, type Memoria } from '@/lib/messaging/intencion'
import type { AiConfig, ChatMessage } from './types'
import { memoriaDe } from '@/lib/messaging/memoria'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import {
  engineSendMedia,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { mapaDeArchivos, separarArchivos } from './archivos'
import { cargarCatalogo, catalogoParaPrompt, importesFueraDeCatalogo } from './catalogo'
import { ETIQUETAS_PROHIBIDAS, separarAcciones } from './acciones'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /**
   * Cuántas automatizaciones atendieron este mismo mensaje (el webhook lo sabe
   * porque las ejecuta antes que a la IA). Con 0 o undefined, la IA contesta;
   * con más de 0, se retira para no escribir dos veces. Si no se pasa nada, se
   * conserva el comportamiento antiguo (retirarse si hay automatizaciones
   * activas de mensaje), por si otro llamador depende de él.
   */
  atendidaPorAutomatizacion?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
// Fila por conversación: si la clienta manda dos mensajes seguidos («Claro» y «Gracias»),
// las dos respuestas ya no corren a la vez (antes se intercalaban sus partes y salían
// dos encabezados de SPEI, la CLABE bajo el de OXXO, la tarjeta dos veces…). La segunda
// espera a que la primera termine de mandar todas sus partes. Railway corre un solo proceso.
const filas = new Map<string, Promise<void>>()

export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const clave = args.conversationId
  const previa = filas.get(clave) ?? Promise.resolve()
  const actual = previa.then(() => responder(args)) // responder nunca lanza
  filas.set(clave, actual)
  try {
    await actual
  } finally {
    if (filas.get(clave) === actual) filas.delete(clave)
  }
}

async function responder(args: DispatchArgs): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed.
    //
    // Ojo con no pasarse: antes bastaba con que la cuenta tuviera UNA
    // automatización de `keyword_match` o `new_message_received` activa para
    // que la IA no contestara nunca — y eso dejaba sin respuesta las fotos, las
    // notas de voz y cualquier texto que no casara con las palabras clave (era
    // el motivo de «no contesta nada»). Ahora el webhook nos dice cuántas
    // automatizaciones atendieron ESTE mensaje y solo se retira si hubo alguna.
    if (args.atendidaPorAutomatizacion !== undefined) {
      if (args.atendidaPorAutomatizacion) return
    } else {
      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', ['new_message_received', 'keyword_match'])
        .limit(1)
      if (autoResponders && autoResponders.length > 0) return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    const siempre = agenteSiempreActivo()
    // Siempre activo: el tope por conversación no aplica (la base solo admite hasta 20).
    const maxReplies = siempre ? 1_000_000 : config.autoReplyMaxPerConversation
    if (conv.ai_reply_count >= maxReplies) return

    // Si esperó en la fila: si ya llegó otro mensaje de la clienta, contesta ese (con todo
    // el contexto); y si el suyo era solo un acuse («ok», «gracias», «claro») y ya se le
    // respondió después, no vuelve a contestar (evita repetir el cierre o los datos de pago).
    if (inboundMessageId) {
      const recientes = await mensajesRecientes(db, conversationId)
      if (hayEntranteMasNuevo(recientes, inboundMessageId)) return
      const propio = recientes.find((m) => m.message_id === inboundMessageId)
      if (
        propio &&
        yaRespondido(recientes, inboundMessageId) &&
        esAcuseCorto(propio.content_type, propio.content_text)
      ) {
        return
      }
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    const inicio = Date.now()
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    const memoria = await memoriaDe(conversationId)
    const { systemPrompt, productos } = await promptAutoRespuesta({
      db,
      accountId,
      config,
      messages,
      memoria,
    })

    // Si el modelo devuelve una respuesta vacía, se reintenta una vez; con el agente
    // siempre activo, si vuelve a fallar se contesta con el respaldo (nunca se queda callado).
    const generar = () => generateReply({ config, systemPrompt, messages })
    const esVacia = (e: unknown) => (e as { code?: string })?.code === 'empty_response'
    let resultado: Awaited<ReturnType<typeof generateReply>>
    const t0 = Date.now()
    try {
      resultado = await generar()
    } catch (e1) {
      if (!esVacia(e1)) throw e1
      try {
        resultado = await generar()
      } catch (e2) {
        if (!siempre || !esVacia(e2)) throw e2
        console.warn('[ai auto-reply] respuesta vacía dos veces: se manda el respaldo')
        resultado = { text: '', handoff: false, usage: null } as unknown as Awaited<ReturnType<typeof generateReply>>
      }
    }
    const latenciaMs = Date.now() - t0
    const { text: textoModelo, handoff: traspaso, usage } = resultado

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
      origen: 'texto',
      latencyMs: latenciaMs,
    })

    // Auditoría anti-alucinación: si el modelo dijo un precio que no está en el
    // catálogo, se registra (no se bloquea el envío; la persona lo ve en la bandeja).
    if (productos.length > 0) {
      const fuera = importesFueraDeCatalogo(textoModelo ?? '', productos)
      if (fuera.length > 0) {
        console.warn(
          `[orquestador] precio fuera de catálogo en la respuesta: ${fuera.join(', ')} (cuenta ${accountId})`,
        )
      }
    }

    // Siempre activo: si el modelo igual pide traspaso o no escribe nada, se contesta
    // con un respaldo amable y la conversación NO se apaga.
    const respaldo = siempre && (traspaso || !textoModelo)
    const text = respaldo ? RESPALDO_SIEMPRE_ACTIVO : textoModelo
    const handoff = respaldo ? false : traspaso
    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true, ai_handoff_summary: summary })
        .eq('id', conversationId)
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId) {
        await db
          .from('conversations')
          .update({ assigned_agent_id: config.handoffAgentId })
          .eq('id', conversationId)
          .is('assigned_agent_id', null)
      }
      return
    }

    if (
      inboundMessageId &&
      (await hasNewerInbound(db, conversationId, inboundMessageId))
    ) {
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: maxReplies,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return

    // La respuesta puede venir partida con [[CORTE]] (por ejemplo, la CLABE y la
    // tarjeta en mensajes sueltos para copiarlas): cada parte sale como un mensaje
    // aparte y en orden.
    // Ritmo humano: antes de cada mensaje se muestra «escribiendo…» y se espera según lo
    // largo del texto (lo que ya tardó el modelo cuenta para el primero). AI_ESCRIBIENDO=off lo quita.
    // [[ETIQUETA:x]] / [[BOTON:x]]: acciones internas; se quitan del texto y se ejecutan al final.
    const acciones = separarAcciones(text)
    // Cada PDF o audio es un mensaje más: entre texto y archivos la respuesta no pasa del
    // tope de mensajes seguidos (regla anti-baneo: 2), o el sobrante se bloquearía.
    const totalArchivos = (acciones.texto.match(/\[\[\s*ARCHIVO\s*:/gi) ?? []).length
    const partes = splitReplyParts(acciones.texto, Math.max(1, maxPartes() - totalArchivos))
    // [[ARCHIVO:clave]] → el archivo sale como adjunto (PDF/audio), nunca como enlace ni como texto.
    const archivos = acciones.texto.toUpperCase().includes('ARCHIVO') ? await cargarArchivos(db, accountId) : {}
    for (let i = 0; i < partes.length; i++) {
      const { texto: textoParte, claves } = separarArchivos(partes[i])
      if (process.env.AI_ESCRIBIENDO !== 'off') {
        if (i > 0 && inboundMessageId) await showTypingIndicator(db, accountId, inboundMessageId)
        const espera = tiempoEscribiendo(textoParte || 'archivo') - (i === 0 ? Date.now() - inicio : 0)
        if (espera > 0) await new Promise((r) => setTimeout(r, espera))
      } else if (i > 0) {
        await new Promise((r) => setTimeout(r, 700))
      }
      if (textoParte) {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: textoParte,
          aiGenerated: true,
        })
      }
      for (const clave of claves) {
        const a = archivos[clave]
        if (!a) {
          console.warn(`[ai auto-reply] la IA pidió el archivo «${clave}», que no está en ai_configs.archivos`)
          continue
        }
        try {
          await engineSendMedia({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            kind: a.tipo ?? 'document',
            link: a.url,
            filename: a.tipo === 'document' || !a.tipo ? a.nombre : undefined,
            caption: a.tipo === 'audio' ? undefined : (a.pie ?? (a.nombre ? `📎 ${a.nombre}` : undefined)),
          } as Parameters<typeof engineSendMedia>[0])
        } catch (err) {
          console.error(`[ai auto-reply] no se pudo mandar el archivo «${clave}»:`, err)
        }
      }
    }
    await ejecutarAcciones(db, accountId, contactId, conversationId, acciones.etiquetas, acciones.botones)
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** Ejecuta lo que la IA pidió con [[ETIQUETA:x]] y [[BOTON:x]], DESPUÉS de mandar sus mensajes. Nunca lanza. */
async function ejecutarAcciones(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
  conversationId: string,
  etiquetas: string[],
  botones: string[],
) {
  for (const nombre of etiquetas) {
    if (ETIQUETAS_PROHIBIDAS.has(nombre)) {
      console.warn(`[ai acciones] la IA intentó poner «${nombre}»: no permitido`)
      continue
    }
    try {
      const { data: tag } = await db.from('tags').select('id').eq('account_id', accountId).eq('name', nombre).maybeSingle()
      if (!tag) {
        console.warn(`[ai acciones] la etiqueta «${nombre}» no existe en la cuenta`)
        continue
      }
      await addContactTagAndDispatch({ db, accountId, contactId, tagId: (tag as { id: string }).id, context: { conversation_id: conversationId } })
    } catch (err) {
      console.error(`[ai acciones] no se pudo poner «${nombre}»:`, err)
    }
  }
  for (const id of botones) {
    // Mismo disparo que un toque de botón real (webhook): automatizaciones interactive_reply con ese id.
    await runAutomationsForTrigger({
      accountId,
      triggerType: 'interactive_reply',
      contactId,
      context: { conversation_id: conversationId, interactive_reply_id: id, message_text: '' },
    }).catch((err) => console.error(`[ai acciones] no se pudo disparar el botón «${id}»:`, err))
  }
}

/** Mapa clave → archivo de la cuenta (ai_configs.archivos). Si falla, la IA solo manda texto. */
async function cargarArchivos(db: ReturnType<typeof supabaseAdmin>, accountId: string) {
  const { data, error } = await db.from('ai_configs').select('archivos').eq('account_id', accountId).maybeSingle()
  if (error) {
    console.error('[ai auto-reply] no se pudo leer ai_configs.archivos:', error)
    return {}
  }
  return mapaDeArchivos((data as { archivos?: unknown } | null)?.archivos)
}

/**
 * Prompt de sistema de la respuesta automática: base de conocimiento,
 * catálogo y guía de esta respuesta (intención + lo ya comunicado).
 * Lo comparten la respuesta real y el simulador del editor de flujos,
 * para que la prueba conteste con el MISMO prompt que producción.
 */
export async function promptAutoRespuesta(args: {
  db: ReturnType<typeof supabaseAdmin>
  accountId: string
  config: AiConfig
  messages: ChatMessage[]
  memoria: Memoria
}): Promise<{ systemPrompt: string; productos: Awaited<ReturnType<typeof cargarCatalogo>> }> {
  const { db, accountId, config, messages, memoria } = args

  // Ground the reply in the account's knowledge base (best-effort).
  const knowledge = await retrieveKnowledge(
    db,
    accountId,
    config,
    latestUserMessage(messages),
  )

  // Catálogo estructurado (Etapa 1): precios exactos inyectados literales
  // para que el agente no tenga que adivinarlos desde el texto libre de la
  // base de conocimiento. Best-effort: sin catálogo se responde como antes.
  const productos = await cargarCatalogo(db, accountId)
  const catalogo = catalogoParaPrompt(productos, { estricto: config.catalogStrict })
  if (productos.length > 0 && catalogo) {
    console.log(`[orquestador] catálogo inyectado: ${productos.length} productos`)
  }

  // Fase 5: qué preguntó (determinista, sin gastar modelo) y qué se le
  // ha comunicado ya. Con eso la respuesta contesta sólo lo preguntado,
  // no repite lo ya dicho y termina esperando a la clienta.
  const ultimo = latestUserMessage(messages) ?? ''
  const intencion = detectarIntencion(ultimo)
  const guia = guiaDeRespuesta({
    intencion,
    memoria,
    temasPreguntados: temasEn(ultimo),
  })
  console.log(`[orquestador] intención: ${intencion} · ya comunicado: ${Object.keys(memoria).join(', ') || 'nada'}`)

  const systemPrompt = buildSystemPrompt({
    userPrompt:
      [config.systemPrompt, catalogo, guia].filter(Boolean).join('\n\n') || null,
    mode: 'auto_reply',
    knowledge,
  })
  return { systemPrompt, productos }
}

/** Cuánto «tarda en escribir» un mensaje: ~30 letras por segundo, entre 1.5 y 7 segundos. */
export function tiempoEscribiendo(texto: string): number {
  return Math.min(7000, Math.max(1500, 800 + texto.length * 33))
}

/** Máximo de mensajes por respuesta (el resto va junto en el último). */
/**
 * Cuántos mensajes puede mandar la IA en una sola respuesta. Ocho era
 * demasiado: cuatro mensajes seguidos ya parecen una ráfaga. Por defecto
 * tres, y se puede bajar por entorno sin desplegar.
 */
const MAX_PARTES_POR_DEFECTO = 2

export function maxPartes(): number {
  const n = Number(process.env.AI_MAX_PARTES)
  return Number.isFinite(n) && n >= 1 && n <= 8 ? n : MAX_PARTES_POR_DEFECTO
}

/**
 * Parte una respuesta en mensajes de WhatsApp: en cada [[CORTE]] y también en cada renglón en
 * blanco (cada párrafo sale como un mensaje corto aparte, como escribe una persona: 13-nov-2026).
 */
export function splitReplyParts(text: string, max: number = maxPartes()): string[] {
  const partes = text
    .split(/\[\[\s*CORTE\s*\]\]/i)
    .flatMap((p) => p.split(/\n[ \t]*\n/))
    .map((p) => p.trim())
    .filter(Boolean)
  if (partes.length === 0) return [text.trim()]
  if (partes.length <= max) return partes
  return [...partes.slice(0, max - 1), partes.slice(max - 1).join('\n')]
}

interface MensajeReciente {
  message_id: string | null
  sender_type?: string | null
  content_type?: string | null
  content_text?: string | null
}

/** Últimos mensajes de la conversación, del más nuevo al más viejo. */
async function mensajesRecientes(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<MensajeReciente[]> {
  const { data, error } = await db
    .from('messages')
    .select('message_id, sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(15)
  if (error || !data) return []
  return data as MensajeReciente[]
}

/** ¿Hay un mensaje de la clienta más nuevo que el que se iba a contestar? (lista: más nuevo primero) */
export function hayEntranteMasNuevo(recientes: MensajeReciente[], inboundId: string): boolean {
  const ult = recientes.find((m) => (m.sender_type ?? 'customer') === 'customer')
  return !!ult && !!ult.message_id && ult.message_id !== inboundId
}

/** ¿Ya salió algún mensaje nuestro (IA, embudo o persona) después de ese mensaje de la clienta? */
export function yaRespondido(recientes: MensajeReciente[], inboundId: string): boolean {
  const i = recientes.findIndex((m) => m.message_id === inboundId)
  if (i <= 0) return false
  return recientes.slice(0, i).some((m) => m.sender_type && m.sender_type !== 'customer')
}

/** Acuse corto que no necesita respuesta propia: texto de hasta 4 palabras y sin pregunta. */
export function esAcuseCorto(tipo?: string | null, texto?: string | null): boolean {
  if (tipo && tipo !== 'text') return false
  const t = (texto ?? '').trim()
  if (!t || /[?¿]/.test(t)) return false
  return t.split(/\s+/).length <= 4
}

async function hasNewerInbound(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  return data[0].message_id !== inboundMessageId
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
