/**
 * Utilidades puras del Seguimiento: slugs, tokens, URLs y lectura del
 * código corto. Sin Supabase ni DOM para poder probarlas en Node.
 */

export const TRACKING_PLATFORMS = ['meta', 'tiktok', 'kwai', 'google'] as const;
export type TrackingPlatform = (typeof TRACKING_PLATFORMS)[number];

/** Origen que puede tener un contacto (el enlace admite «organic»). */
export const LINK_PLATFORMS = [...TRACKING_PLATFORMS, 'organic'] as const;
export type LinkPlatform = (typeof LINK_PLATFORMS)[number];

export const CLICK_ID_KEYS = [
  'fbclid',
  'gclid',
  'ttclid',
  'kwai_click_id',
  'msclkid',
] as const;

export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

const PARAM_KEYS = new Set<string>([...CLICK_ID_KEYS, ...UTM_KEYS]);
const MAX_PARAM_LENGTH = 300;

/** «Promo Glúteos 🍑» → «promo-gluteos». */
export function slugify(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'enlace';
}

/** 6 caracteres alfanuméricos para el «#token» del mensaje. */
export function generarTokenClic(): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  return uuid.slice(0, 6);
}

/**
 * Número para wa.me: solo dígitos, 7–15. `null` si no es utilizable.
 * Acepta «+52 1 55 1234 5678» y devuelve «5215512345678».
 */
export function normalizarTelefono(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** URL pública del enlace, con las UTMs por defecto que falten. */
export function construirUrlEnlace(
  baseUrl: string,
  slug: string,
  utm: Record<string, string> = {},
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}/r/${slug}`);
  for (const key of UTM_KEYS) {
    const valor = utm[key];
    if (valor) url.searchParams.set(key, valor);
  }
  return url.toString();
}

/**
 * URL de WhatsApp con el texto y el código corto. Si `token` es null se
 * manda solo el texto (el clic no se pudo registrar: mejor no ensuciar).
 */
export function construirUrlWhatsApp(
  telefono: string,
  texto: string | null | undefined,
  token: string | null,
): string | null {
  const num = normalizarTelefono(telefono);
  if (!num) return null;
  const partes = [texto?.trim() ?? '', token ? `#${token}` : ''].filter(Boolean);
  const url = new URL(`https://wa.me/${num}`);
  if (partes.length > 0) url.searchParams.set('text', partes.join(' '));
  return url.toString();
}

/** Deja solo las claves de campaña conocidas y recorta valores. */
export function limpiarParams(
  input: URLSearchParams | Record<string, string | null | undefined>,
): Record<string, string> {
  const salida: Record<string, string> = {};
  const entries =
    input instanceof URLSearchParams
      ? [...input.entries()]
      : Object.entries(input);
  for (const [clave, valor] of entries) {
    if (!PARAM_KEYS.has(clave)) continue;
    if (typeof valor !== 'string') continue;
    const limpio = valor.trim().slice(0, MAX_PARAM_LENGTH);
    if (limpio) salida[clave] = limpio;
  }
  return salida;
}

/** Aplica las UTMs por defecto del enlace sin pisar las del anuncio. */
export function aplicarUtmsPorDefecto(
  params: Record<string, string>,
  defaults: Record<string, string> | null | undefined,
): Record<string, string> {
  const salida = { ...params };
  if (!defaults) return salida;
  for (const key of UTM_KEYS) {
    const valor = defaults[key];
    if (!salida[key] && typeof valor === 'string' && valor.trim()) {
      salida[key] = valor.trim().slice(0, MAX_PARAM_LENGTH);
    }
  }
  return salida;
}

/**
 * Busca un `#token` de 6 caracteres. No garantiza que exista: el
 * llamador consulta la base. Devuelve el texto sin el código.
 */
export function extraerCodigo(
  texto: string | null | undefined,
): { token: string; limpio: string } | null {
  if (!texto) return null;
  const m = /(?:^|\s)#([a-z0-9]{6})\b/i.exec(texto);
  if (!m) return null;
  const token = m[1].toLowerCase();
  const limpio = texto
    .replace(new RegExp(`\\s*#${token}\\b`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { token, limpio };
}

/** Guioniza un slug libre (para la ruta pública). */
export function slugValido(slug: string): boolean {
  return /^[a-z0-9-]{3,64}$/.test(slug);
}

/** UTMs y clics que vengan dentro de una URL (p. ej. referral.source_url). */
export function parametrosDeUrl(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    return limpiarParams(new URL(raw).searchParams);
  } catch {
    return {};
  }
}
