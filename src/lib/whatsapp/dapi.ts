/**
 * D-API (https://d-api.cloud): WhatsApp Web por QR, igual que la
 * integración «D-API» de Leona.
 *
 * Una isla D-API vive en `whatsapp_connections` como cualquier otra:
 *   - `phone_number_id` = `dapi:<sessionId>` (prefijo = proveedor)
 *   - `access_token`    = API Key secreta de D-API (cifrada)
 *   - `verify_token`    = secreto del webhook de entrada (cifrado)
 *   - `app_secret`      = secreto con el que se firma el payload traducido
 *                         antes de pasarlo al webhook de Meta (cifrado)
 *
 * `meta-api.ts` desvía aquí cada envío cuyo `phoneNumberId` empieza por
 * `dapi:`, y el webhook de D-API traduce sus eventos al formato de Meta,
 * así flujos, IA, inbox y ventas funcionan sin saber del proveedor.
 *
 * Doc: https://docs.d-api.cloud — header `Authorization: <API_KEY>` (sin
 * Bearer). Las claves `pk_live_…` NO sirven para la API REST.
 */

export const DAPI_BASE = 'https://api.d-api.cloud/api/v1'
const PREFIJO = 'dapi:'
const PREFIJO_MEDIA = 'dapi_'
const HOST_MEDIA = 'media.d-api.cloud'

export class DapiError extends Error {
  readonly httpStatus: number
  constructor(message: string, httpStatus: number) {
    super(message)
    this.name = 'DapiError'
    this.httpStatus = httpStatus
  }
}

export function esDapi(phoneNumberId: string | null | undefined): boolean {
  return typeof phoneNumberId === 'string' && phoneNumberId.startsWith(PREFIJO)
}

export function phoneNumberIdDeSesion(sessionId: string): string {
  return `${PREFIJO}${sessionId}`
}

export function sesionDe(phoneNumberId: string): string {
  return phoneNumberId.slice(PREFIJO.length)
}

export function claveValida(apiKey: string): boolean {
  const k = apiKey.trim()
  return k.length >= 10 && !k.startsWith('pk_live_')
}

/** `5215512345678@s.whatsapp.net` → `5215512345678`. */
export function numeroDeJid(jid: string | null | undefined): string {
  if (!jid) return ''
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
}

function destino(to: string): string {
  return to.replace(/\D/g, '')
}

async function llamar(
  apiKey: string,
  metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  ruta: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${DAPI_BASE}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: apiKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const texto = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {}
  } catch {
    json = {}
  }
  if (!res.ok) {
    const msg =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.message === 'string' && json.message) ||
      `D-API error: ${res.status}`
    throw new DapiError(msg, res.status)
  }
  return json
}

// ============================================================
// Sesiones
// ============================================================

export async function crearSesion(args: {
  apiKey: string
  sessionId: string
  webhookUrl: string
}): Promise<void> {
  await llamar(args.apiKey, 'POST', '/sessions', {
    sessionId: args.sessionId,
    type: 'unofficial',
    connectionMode: 'qr',
    webhookUrl: args.webhookUrl,
    webhookConfig: {
      enabled: true,
      type: 'single',
      events: [
        'messages.received',
        'message.delivered',
        'message.read',
        'connection.status',
      ],
    },
    ignoreGroups: true,
    ignoreStatus: true,
    historySync: false,
    receiveCalls: false,
  })
}

export interface EstadoQr {
  status: string
  qrImage: string | null
}

export async function obtenerQr(args: {
  apiKey: string
  sessionId: string
}): Promise<EstadoQr> {
  const json = await llamar(
    args.apiKey,
    'GET',
    `/sessions/${encodeURIComponent(args.sessionId)}/qr`,
  )
  return {
    status: typeof json.status === 'string' ? json.status : 'unknown',
    qrImage: typeof json.qrCodeImage === 'string' ? json.qrCodeImage : null,
  }
}

export async function borrarSesion(args: {
  apiKey: string
  sessionId: string
}): Promise<void> {
  await llamar(args.apiKey, 'DELETE', `/sessions/${encodeURIComponent(args.sessionId)}`)
}

// ============================================================
// API oficial (WhatsApp Cloud API con D-API como proveedor)
// ============================================================
//
// El número oficial se conecta en el panel de D-API (Embedded Signup o
// Coexistencia). Su sesión se llama «cloud-<uuid>». Aquí: listarlas,
// leer su WABA/número, apuntar su webhook al WaCRM (modo «normalized»,
// el mismo sobre que el QR) y mandar/listar plantillas aprobadas.

/** ¿La isla D-API es un número oficial (Cloud API)? */
export function esSesionOficial(phoneNumberId: string | null | undefined): boolean {
  return esDapi(phoneNumberId) && sesionDe(phoneNumberId as string).startsWith('cloud-');
}

export interface SesionDapi {
  sessionId: string;
  nombre: string;
  telefono: string;
  estado: string;
  oficial: boolean;
}

const texto = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Lista que venga como array, {data: []}, {sessions: []} o {data: {items: []}}. */
function lista(json: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidatos = [json.data, json.sessions, json.items, (json.data as Record<string, unknown> | undefined)?.items,
    (json.data as Record<string, unknown> | undefined)?.sessions];
  for (const c of candidatos) if (Array.isArray(c)) return c as Array<Record<string, unknown>>;
  return Array.isArray(json) ? (json as unknown as Array<Record<string, unknown>>) : [];
}

export async function listarSesiones(apiKey: string, tipo: 'cloud_api' | 'unofficial'): Promise<SesionDapi[]> {
  const json = await llamar(apiKey, 'GET', `/sessions?type=${tipo}&limit=100`);
  return lista(json).map((s) => {
    const id = texto(s.sessionId ?? s.session_id ?? s.id);
    return {
      sessionId: id,
      nombre: texto(s.name ?? s.verifiedName ?? s.verified_name ?? s.displayName ?? id),
      telefono: numeroDeJid(texto(s.phone ?? s.phoneNumber ?? s.displayPhoneNumber ?? s.display_phone_number ?? s.jid)),
      estado: texto(s.status ?? s.connectionStatus ?? ''),
      oficial: tipo === 'cloud_api' || id.startsWith('cloud-'),
    };
  }).filter((s) => s.sessionId);
}

export interface ConexionOficial {
  wabaId: string | null;
  phoneNumberId: string | null;
  telefono: string;
  nombre: string;
  calidad: string | null;
}

export async function obtenerConexionOficial(apiKey: string, id: string): Promise<ConexionOficial> {
  const json = await llamar(apiKey, 'GET', `/connections/cloud-api/${encodeURIComponent(id)}`);
  const d = (json.data ?? json) as Record<string, unknown>;
  const salud = (d.health ?? {}) as Record<string, unknown>;
  return {
    wabaId: texto(d.wabaId ?? d.waba_id) || null,
    phoneNumberId: texto(d.phoneNumberId ?? d.phone_number_id) || null,
    telefono: numeroDeJid(texto(d.displayPhoneNumber ?? d.display_phone_number ?? d.phoneNumber ?? d.phone)),
    nombre: texto(d.verifiedName ?? d.verified_name ?? d.name),
    calidad: texto(d.qualityRating ?? d.quality_rating ?? salud.qualityRating ?? salud.quality) || null,
  };
}

/** Apunta el webhook del número oficial al WaCRM (sobre «normalized»). */
export async function configurarWebhookOficial(apiKey: string, id: string, webhookUrl: string | null): Promise<void> {
  await llamar(apiKey, 'PATCH', `/connections/cloud-api/${encodeURIComponent(id)}`, {
    webhookUrl,
    webhookMode: 'normalized',
  });
}

export async function enviarPlantilla(args: {
  apiKey: string;
  phoneNumberId: string;
  to: string;
  name: string;
  language: string;
  components?: unknown[];
}): Promise<{ messageId: string }> {
  const json = await llamar(args.apiKey, 'POST', '/messages/send/template', {
    sessionId: sesionDe(args.phoneNumberId),
    to: destino(args.to),
    template: {
      name: args.name,
      language: args.language,
      ...(args.components?.length ? { components: args.components } : {}),
    },
  });
  return { messageId: idDelEnvio(json) };
}

/** Plantillas de la conexión oficial (todas, con su estado). */
export async function listarPlantillas(apiKey: string, id: string): Promise<Array<Record<string, unknown>>> {
  const json = await llamar(apiKey, 'GET', `/connections/cloud-api/${encodeURIComponent(id)}/templates/all`);
  return lista(json);
}

/**
 * Plantilla de D-API → forma de Meta ({id,name,language,status,category,
 * components}) para reutilizar la sincronización que ya existe.
 */
export function plantillaComoMeta(t: Record<string, unknown>) {
  const components: Array<Record<string, unknown>> = [];
  if (Array.isArray(t.components)) {
    return {
      id: texto(t.id), name: texto(t.name), language: texto(t.language),
      status: texto(t.status), category: texto(t.category),
      components: t.components as Array<Record<string, unknown>>,
    };
  }
  const header = texto(t.headerFormat).toUpperCase();
  if (header && header !== 'NONE') {
    components.push({ type: 'HEADER', format: header, ...(t.headerText ? { text: texto(t.headerText) } : {}) });
  }
  components.push({ type: 'BODY', text: texto(t.body) });
  if (t.footerText) components.push({ type: 'FOOTER', text: texto(t.footerText) });
  if (Array.isArray(t.buttons) && t.buttons.length) components.push({ type: 'BUTTONS', buttons: t.buttons });
  return {
    id: texto(t.id) || `${texto(t.name)}_${texto(t.language)}`,
    name: texto(t.name),
    language: texto(t.language),
    status: texto(t.status),
    category: texto(t.category),
    components,
  };
}

// ============================================================
// Envíos
// ============================================================

/** La doc no fija el campo del id en la respuesta: se prueban los usuales. */
export function idDelEnvio(json: Record<string, unknown>): string {
  const d = (json.data ?? json) as Record<string, unknown>
  const key = (d.key ?? (d.message as Record<string, unknown> | undefined)?.key) as
    | Record<string, unknown>
    | undefined
  const candidato =
    d.messageId ?? d.message_id ?? d.id ?? key?.id ?? json.messageId ?? json.id
  if (typeof candidato === 'string' && candidato) return candidato
  return `dapi-${crypto.randomUUID()}`
}

export async function enviarTexto(args: {
  apiKey: string
  phoneNumberId: string
  to: string
  text: string
}): Promise<{ messageId: string }> {
  const json = await llamar(args.apiKey, 'POST', '/messages/send/text', {
    sessionId: sesionDe(args.phoneNumberId),
    to: destino(args.to),
    text: args.text,
  })
  return { messageId: idDelEnvio(json) }
}

export type TipoMediaDapi = 'image' | 'video' | 'document' | 'audio' | 'sticker'

export async function enviarMedia(args: {
  apiKey: string
  phoneNumberId: string
  to: string
  kind: TipoMediaDapi
  link: string
  caption?: string
  filename?: string
}): Promise<{ messageId: string }> {
  const { kind } = args
  const body: Record<string, unknown> = {
    sessionId: sesionDe(args.phoneNumberId),
    to: destino(args.to),
    [kind]: args.link,
  }
  if (args.caption && (kind === 'image' || kind === 'video' || kind === 'document')) {
    body.caption = args.caption
  }
  if (kind === 'document' && args.filename) body.fileName = args.filename
  if (kind === 'audio') body.ptt = true
  const json = await llamar(args.apiKey, 'POST', `/messages/send/${kind}`, body)
  return { messageId: idDelEnvio(json) }
}

export async function enviarReaccion(args: {
  apiKey: string
  phoneNumberId: string
  to: string
  messageId: string
  emoji: string
}): Promise<{ messageId: string }> {
  const json = await llamar(args.apiKey, 'POST', '/messages/send/reaction', {
    sessionId: sesionDe(args.phoneNumberId),
    to: destino(args.to),
    messageId: args.messageId,
    emoji: args.emoji,
    fromMe: false,
  })
  return { messageId: idDelEnvio(json) }
}

/**
 * Botones y listas de Meta → texto con opciones numeradas. El motor de
 * flujos ya empareja la respuesta escrita (título o número de opción).
 */
export function textoDeMenu(args: {
  bodyText: string
  headerText?: string
  footerText?: string
  opciones: string[]
}): string {
  const partes: string[] = []
  if (args.headerText?.trim()) partes.push(`*${args.headerText.trim()}*`)
  partes.push(args.bodyText.trim())
  partes.push(args.opciones.map((o, i) => `${i + 1}. ${o}`).join('\n'))
  if (args.footerText?.trim()) partes.push(`_${args.footerText.trim()}_`)
  return partes.join('\n\n')
}

// ============================================================
// Media entrante
// ============================================================

/**
 * El CRM guarda un «media id» por adjunto y luego lo resuelve con
 * getMediaUrl. Para D-API el id lleva dentro el enlace estable
 * (`media.d-api.cloud`) y el MIME.
 */
export function mediaIdDapi(url: string, mime: string | null | undefined): string {
  const json = JSON.stringify({ u: url, m: mime ?? '' })
  return PREFIJO_MEDIA + Buffer.from(json, 'utf8').toString('base64url')
}

export function esMediaIdDapi(mediaId: string): boolean {
  return mediaId.startsWith(PREFIJO_MEDIA)
}

export function leerMediaIdDapi(mediaId: string): { url: string; mimeType: string } | null {
  try {
    const raw = Buffer.from(mediaId.slice(PREFIJO_MEDIA.length), 'base64url').toString('utf8')
    const { u, m } = JSON.parse(raw) as { u?: string; m?: string }
    if (!u || new URL(u).hostname !== HOST_MEDIA) return null
    return { url: u, mimeType: m || 'application/octet-stream' }
  } catch {
    return null
  }
}

export function esUrlMediaDapi(url: string): boolean {
  try {
    return new URL(url).hostname === HOST_MEDIA
  } catch {
    return false
  }
}

// ============================================================
// Webhook D-API → formato de Meta
// ============================================================

export interface EventoDapi {
  event?: string
  sessionId?: string
  data?: Record<string, unknown>
}

const TIPOS_MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker'])

function segundos(ms: unknown): string {
  const n = Number(ms)
  const s = Number.isFinite(n) && n > 0 ? Math.floor(n > 1e12 ? n / 1000 : n) : Math.floor(Date.now() / 1000)
  return String(s)
}

/**
 * Respuesta a botón/lista en el sobre de D-API (sus nombres varían según
 * el tipo de conexión): devuelve el id elegido para que el flujo avance
 * igual que con Meta, o null si no es una respuesta interactiva.
 */
function respuestaInteractiva(
  d: Record<string, unknown>,
): { tipo: 'button_reply' | 'list_reply' | 'button'; id: string; titulo: string } | null {
  const tipo = String(d.type ?? '');
  const inter = (d.interactive ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const titulo = (v: unknown) => (typeof v === 'string' ? v : '');
  if (tipo === 'list_response' || inter.list_reply) {
    const id = String(d.selected_row_id ?? d.selectedRowId ?? inter.list_reply?.id ?? '');
    return id ? { tipo: 'list_reply', id, titulo: titulo(d.selected_title ?? inter.list_reply?.title ?? d.message) } : null;
  }
  if (tipo === 'template_button_reply' || (tipo === 'button' && (d.button as Record<string, unknown>)?.payload)) {
    const b = (d.button ?? {}) as Record<string, unknown>;
    const id = String(d.selected_id ?? d.selectedId ?? b.payload ?? '');
    return id ? { tipo: 'button', id, titulo: titulo(d.selected_display_text ?? b.text ?? d.message) } : null;
  }
  if (tipo === 'buttons_response' || tipo === 'button_reply' || tipo === 'interactive' || inter.button_reply) {
    const id = String(d.selected_id ?? d.selectedButtonId ?? d.selected_button_id ?? inter.button_reply?.id ?? '');
    return id
      ? { tipo: 'button_reply', id, titulo: titulo(d.selected_display_text ?? inter.button_reply?.title ?? d.message) }
      : null;
  }
  return null;
}

/**
 * Traduce un evento de D-API al cuerpo que manda Meta a su webhook.
 * Devuelve null cuando no hay nada que procesar (grupos, propios, etc.).
 */
export function aWebhookMeta(
  evento: EventoDapi,
  phoneNumberId: string,
): { entry: unknown[] } | null {
  const d = evento.data ?? {}
  const metadata = { display_phone_number: '', phone_number_id: phoneNumberId }
  const envolver = (value: Record<string, unknown>) => ({
    entry: [
      {
        id: phoneNumberId,
        changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', metadata, ...value } },
        ],
      },
    ],
  })

  if (evento.event === 'message.delivered' || evento.event === 'message.read') {
    const id = typeof d.message_id === 'string' ? d.message_id : ''
    if (!id) return null
    return envolver({
      statuses: [
        {
          id,
          status: evento.event === 'message.read' ? 'read' : 'delivered',
          timestamp: segundos(d.timestamp),
          recipient_id: numeroDeJid(d.remote_jid as string),
        },
      ],
    })
  }

  if (evento.event === 'message.failed') {
    const idFallo = String(d.message_id ?? d.id ?? '')
    if (!idFallo) return null
    const err = (d.error ?? (Array.isArray(d.errors) ? d.errors[0] : null) ?? {}) as Record<string, unknown>
    return envolver({
      statuses: [
        {
          id: idFallo,
          status: 'failed',
          timestamp: segundos(d.timestamp),
          recipient_id: numeroDeJid((d.remote_jid as string) ?? (d.to as string)),
          errors: [
            {
              code: Number(err.code ?? d.error_code ?? 0) || 0,
              title: String(err.title ?? err.message ?? d.reason ?? 'failed'),
              ...(err.message ? { message: String(err.message) } : {}),
            },
          ],
        },
      ],
    })
  }

  if (evento.event !== 'messages.received') return null
  if (d.fromMe === true || d.is_group === true || d.isMetaAI === true) return null

  const id = typeof d.id === 'string' ? d.id : ''
  const from = (d.from ?? {}) as { jid?: string; name?: string }
  const numero = numeroDeJid(from.jid)
  if (!id || !numero || from.jid?.endsWith('@g.us')) return null

  const tipo = typeof d.type === 'string' ? d.type : 'text'
  const texto = typeof d.message === 'string' ? d.message : ''
  const mediaData = (d.media_data ?? {}) as {
    mimetype?: string
    caption?: string
    filename?: string
  }
  const mediaUrl = typeof d.media_url === 'string' ? d.media_url : ''

  const mensaje: Record<string, unknown> = { id, from: numero, timestamp: segundos(d.timestamp) }
  const respuesta = respuestaInteractiva(d)
  if (respuesta?.tipo === 'button') {
    // Botón de una plantilla (QUICK_REPLY): como Meta, `button.payload`.
    mensaje.type = 'button'
    mensaje.button = { payload: respuesta.id, text: respuesta.titulo }
  } else if (respuesta) {
    mensaje.type = 'interactive'
    mensaje.interactive =
      respuesta.tipo === 'list_reply'
        ? { type: 'list_reply', list_reply: { id: respuesta.id, title: respuesta.titulo } }
        : { type: 'button_reply', button_reply: { id: respuesta.id, title: respuesta.titulo } }
  } else if (TIPOS_MEDIA.has(tipo) && mediaUrl && esUrlMediaDapi(mediaUrl)) {
    const media: Record<string, unknown> = {
      id: mediaIdDapi(mediaUrl, mediaData.mimetype),
      mime_type: mediaData.mimetype ?? 'application/octet-stream',
    }
    const caption = mediaData.caption || texto
    if (caption && tipo !== 'audio' && tipo !== 'sticker') media.caption = caption
    if (tipo === 'document' && mediaData.filename) media.filename = mediaData.filename
    mensaje.type = tipo
    mensaje[tipo] = media
  } else if (texto.trim()) {
    // Texto, respuestas de lista/botón, mensajes editados, etc.
    mensaje.type = 'text'
    mensaje.text = { body: texto }
  } else {
    return null
  }

  const nombre = from.name || (typeof d.from_name === 'string' ? d.from_name : '')
  return envolver({
    contacts: [{ profile: { name: nombre || undefined }, wa_id: numero }],
    messages: [mensaje],
  })
}
