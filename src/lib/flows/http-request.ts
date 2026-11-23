/**
 * Ejecución de Integración HTTP.
 *
 * Todo lo que sale de aquí es una petición del servidor a una URL
 * elegida por el cliente: el guard SSRF de `lib/webhooks/ssrf` es
 * obligatorio, las redirecciones se desactivan y la respuesta se lee
 * con tope de tamaño.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import { decrypt } from "@/lib/whatsapp/encryption";
import { cargarDatosFichas, sustituirFichas, type DatosFichas } from "./bloques";
import {
  HTTP_RESPONSE_MAX_BYTES,
  HTTP_TIMEOUT_MS,
  HTTP_TIMEOUT_MAX_MS,
  type HttpRequestNodeConfig,
} from "./types";

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detalle?: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export interface ResultadoHttp {
  status: number;
  ok: boolean;
  duration_ms: number;
  /** Texto o JSON ya parseado. */
  respuesta: unknown;
  /** Texto truncado para logs/vista previa. */
  preview: string;
  mapped: Record<string, string>;
  headers: Record<string, string>;
}

/** Rutas tipo `data.items[0].id` o `$.data.items[0].id`. */
export function extraerRutaJson(objeto: unknown, ruta: string): unknown {
  let actual = objeto;
  let limpia = ruta.trim();
  if (limpia.startsWith("$.")) limpia = limpia.slice(2);
  else if (limpia === "$") return actual;
  if (!limpia) return actual;

  const partes = limpia
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  for (const parte of partes) {
    if (actual === null || actual === undefined) return undefined;
    if (Array.isArray(actual)) {
      const idx = Number(parte);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      actual = actual[idx];
    } else if (typeof actual === "object") {
      actual = (actual as Record<string, unknown>)[parte];
    } else {
      return undefined;
    }
  }
  return actual;
}

/** Convierte el valor extraído a texto para `flow_runs.vars`. */
export function valorAVariable(valor: unknown): string {
  if (valor === undefined || valor === null) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  try {
    return JSON.stringify(valor);
  } catch {
    return String(valor);
  }
}

export function mapearRespuesta(
  json: unknown,
  mapa: HttpRequestNodeConfig["response_map"],
): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const item of mapa ?? []) {
    const clave = item.var_key?.trim();
    if (!clave) continue;
    salida[clave] = valorAVariable(extraerRutaJson(json, item.path));
  }
  return salida;
}

/** Cabeceras seguras para guardar en logs (sin Authorization/Cookie). */
export function cabecerasPublicas(headers: Headers): Record<string, string> {
  const salida: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "authorization" || key.toLowerCase() === "cookie") return;
    salida[key] = value;
  });
  return salida;
}

async function leerTextoLimitado(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

async function resolverCredencial(
  db: SupabaseClient,
  accountId: string,
  cfg: HttpRequestNodeConfig,
  textos: string[],
): Promise<{ valor: string | null; nombre: string | null }> {
  const necesita =
    Boolean(cfg.credential_id) ||
    textos.some((t) => /\{\{\s*credential\.[\w.-]+\s*\}\}/.test(t));
  if (!necesita) return { valor: null, nombre: null };

  let fila: { name: string; value: string } | null = null;
  if (cfg.credential_id) {
    const { data } = await db
      .from("flow_credentials")
      .select("name, value")
      .eq("id", cfg.credential_id)
      .eq("account_id", accountId)
      .maybeSingle();
    fila = (data as { name: string; value: string } | null) ?? null;
  }
  if (!fila) {
    const match = textos.join("\n").match(/\{\{\s*credential\.([\w.-]+)\s*\}\}/);
    if (match?.[1]) {
      const { data } = await db
        .from("flow_credentials")
        .select("name, value")
        .eq("account_id", accountId)
        .ilike("name", match[1])
        .maybeSingle();
      fila = (data as { name: string; value: string } | null) ?? null;
    }
  }
  if (!fila) return { valor: null, nombre: null };
  try {
    return { valor: decrypt(fila.value), nombre: fila.name };
  } catch {
    throw new HttpRequestError("La credencial HTTP no se pudo descifrar.");
  }
}

/** Arma la petición ya interpolada y con la credencial resuelta. */
export async function construirSolicitud(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    vars: Record<string, unknown>;
    cfg: HttpRequestNodeConfig;
  },
): Promise<{
  url: string;
  method: HttpRequestNodeConfig["method"];
  headers: Array<{ key: string; value: string }>;
  body?: string;
  credentialName: string | null;
}> {
  const textos = [
    args.cfg.url,
    ...(args.cfg.headers ?? []).flatMap((h) => [h.key, h.value]),
    args.cfg.body ?? "",
  ];
  const datos: DatosFichas = await cargarDatosFichas(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    vars: args.vars,
    textos,
  });
  const credencial = await resolverCredencial(db, args.accountId, args.cfg, textos);

  const interpolar = (texto: string) =>
    sustituirFichas(texto, datos).replace(
      /\{\{\s*credential\.[\w.-]+\s*\}\}/g,
      credencial.valor ?? "",
    );

  const url = interpolar(args.cfg.url).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpRequestError("La URL de la integración no es válida.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpRequestError("Solo se permiten URLs http:// o https://.");
  }
  const deliverable = await isDeliverableUrl(parsed.toString());
  if (!deliverable) {
    throw new HttpRequestError(
      "La URL apunta a una red privada o no es públicamente accesible.",
    );
  }

  const headers = (args.cfg.headers ?? [])
    .map((h) => ({ key: interpolar(h.key).trim(), value: interpolar(h.value) }))
    .filter((h) => h.key);
  if (credencial.valor && !headers.some((h) => h.key.toLowerCase() === "authorization")) {
    headers.push({ key: "Authorization", value: credencial.valor });
  }

  let body: string | undefined;
  if (args.cfg.body_type !== "none") {
    body = interpolar(args.cfg.body ?? "");
    if (args.cfg.body_type === "json") {
      try {
        JSON.parse(body);
      } catch {
        throw new HttpRequestError("El cuerpo JSON no es válido después de aplicar variables.");
      }
      if (!headers.some((h) => h.key.toLowerCase() === "content-type")) {
        headers.push({ key: "Content-Type", value: "application/json" });
      }
    } else if (args.cfg.body_type === "form") {
      if (!headers.some((h) => h.key.toLowerCase() === "content-type")) {
        headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
      }
    }
  }

  return {
    url: parsed.toString(),
    method: args.cfg.method,
    headers,
    body,
    credentialName: credencial.nombre,
  };
}

/** Ejecuta la petición y devuelve el resultado ya mapeado. */
export async function ejecutarHttpRequest(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    vars: Record<string, unknown>;
    cfg: HttpRequestNodeConfig;
  },
): Promise<ResultadoHttp> {
  const solicitud = await construirSolicitud(db, args);
  const timeout = Math.min(
    Math.max(Number(args.cfg.timeout_ms) || HTTP_TIMEOUT_MS, 1000),
    HTTP_TIMEOUT_MAX_MS,
  );

  const inicio = Date.now();
  let res: Response;
  try {
    res = await fetch(solicitud.url, {
      method: solicitud.method,
      headers: Object.fromEntries(solicitud.headers.map((h) => [h.key, h.value])),
      body: solicitud.method === "GET" ? undefined : solicitud.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new HttpRequestError(
      "No se pudo conectar con el servicio externo.",
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  }
  const duration = Date.now() - inicio;
  const texto = await leerTextoLimitado(res, HTTP_RESPONSE_MAX_BYTES);
  const contentType = res.headers.get("content-type") ?? "";
  let respuesta: unknown = texto;
  if (contentType.includes("application/json") && texto.trim()) {
    try {
      respuesta = JSON.parse(texto);
    } catch {
      respuesta = texto;
    }
  }

  const resultado: ResultadoHttp = {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    duration_ms: duration,
    respuesta,
    preview: texto.slice(0, HTTP_RESPONSE_MAX_BYTES),
    mapped: mapearRespuesta(respuesta, args.cfg.response_map),
    headers: cabecerasPublicas(res.headers),
  };

  if (!resultado.ok && args.cfg.continue_on_error === false) {
    throw new HttpRequestError(
      `El servicio respondió ${res.status}.`,
      res.status,
      texto.slice(0, 500),
    );
  }
  return resultado;
}
