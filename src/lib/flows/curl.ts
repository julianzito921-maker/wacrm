/**
 * Parser del botón «Pegar cURL» de Integración HTTP.
 *
 * Acepta los flags habituales de cURL y devuelve solo lo que el nodo
 * guarda: método, URL, cabeceras y cuerpo. No ejecuta nada, no lee
 * archivos (`@archivo`) y no resuelve variables de shell.
 */

import type { HttpMethod } from "./types";

export interface CurlParseado {
  method: HttpMethod;
  url: string;
  headers: Array<{ key: string; value: string }>;
  body: string;
}

export class CurlInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlInvalido";
  }
}

/** Divide un comando respetando comillas simples/dobles y `\` + salto. */
export function tokenizarCurl(comando: string): string[] {
  const limpio = comando.replace(/\\\r?\n/g, " ");
  const tokens: string[] = [];
  let actual = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (const ch of limpio) {
    if (escape) {
      actual += ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else actual += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else actual += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (actual) {
        tokens.push(actual);
        actual = "";
      }
      continue;
    }
    actual += ch;
  }
  if (escape) actual += "\\";
  if (quote) throw new CurlInvalido("Hay comillas sin cerrar en el cURL.");
  if (actual) tokens.push(actual);
  return tokens;
}

function base64Utf8(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario);
}

function metodoValido(valor: string): HttpMethod {
  const method = valor.toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "DELETE") {
    return method;
  }
  throw new CurlInvalido(`Método no soportado: ${valor}`);
}

/**
 * Parsea un comando cURL. Lanza `CurlInvalido` con un mensaje claro
 * cuando no hay URL o el método no está soportado.
 */
export function parsearCurl(comando: string): CurlParseado {
  const tokens = tokenizarCurl(comando.trim());
  if (tokens.length === 0) throw new CurlInvalido("El cURL está vacío.");

  let url = "";
  let method: HttpMethod | null = null;
  let body = "";
  const headers: Array<{ key: string; value: string }> = [];
  const datos: string[] = [];

  const addHeader = (raw: string) => {
    const idx = raw.indexOf(":");
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) headers.push({ key, value });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (i === 0 && token.toLowerCase() === "curl") continue;

    const next = () => {
      i += 1;
      if (i >= tokens.length) throw new CurlInvalido(`Falta el valor de ${token}.`);
      return tokens[i];
    };

    switch (token) {
      case "-X":
      case "--request":
        method = metodoValido(next());
        break;
      case "-H":
      case "--header":
        addHeader(next());
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-ascii":
      case "--data-binary": {
        const valor = next();
        if (valor.startsWith("@")) {
          throw new CurlInvalido("No se admiten archivos (@archivo) en el cURL; pega el contenido.");
        }
        datos.push(valor);
        break;
      }
      case "--data-urlencode": {
        const valor = next();
        if (valor.includes("=")) {
          const idx = valor.indexOf("=");
          datos.push(`${valor.slice(0, idx)}=${encodeURIComponent(valor.slice(idx + 1))}`);
        } else {
          datos.push(encodeURIComponent(valor));
        }
        break;
      }
      case "-u":
      case "--user": {
        const valor = next();
        headers.push({ key: "Authorization", value: `Basic ${base64Utf8(valor)}` });
        break;
      }
      case "-b":
      case "--cookie":
        headers.push({ key: "Cookie", value: next() });
        break;
      case "-A":
      case "--user-agent":
        headers.push({ key: "User-Agent", value: next() });
        break;
      case "-e":
      case "--referer":
        headers.push({ key: "Referer", value: next() });
        break;
      case "--url":
        url = next();
        break;
      case "-G":
      case "--get":
        method = "GET";
        break;
      case "-I":
      case "--head":
        throw new CurlInvalido("El método HEAD no está soportado; usa GET.");
      case "-s":
      case "--silent":
      case "-S":
      case "--show-error":
      case "-k":
      case "--insecure":
      case "-L":
      case "--location":
      case "--compressed":
      case "-i":
      case "--include":
      case "-v":
      case "--verbose":
        break;
      default:
        if (token.startsWith("-")) break; // flags desconocidos: se ignoran
        if (!url) url = token;
    }
  }

  body = datos.join("&");
  if (method === "GET" && body) {
    const separador = url.includes("?") ? "&" : "?";
    url = `${url}${separador}${body}`;
    body = "";
  }
  if (!method) method = body ? "POST" : "GET";
  if (!url) throw new CurlInvalido("No se encontró una URL en el cURL.");
  if (!/^https?:\/\//i.test(url)) {
    throw new CurlInvalido("La URL debe empezar por http:// o https://.");
  }

  const tieneContentType = headers.some(
    (h) => h.key.toLowerCase() === "content-type",
  );
  if (body && !tieneContentType) {
    const esJson = body.trim().startsWith("{") || body.trim().startsWith("[");
    headers.push({
      key: "Content-Type",
      value: esJson ? "application/json" : "application/x-www-form-urlencoded",
    });
  }

  return { method, url, headers, body };
}
