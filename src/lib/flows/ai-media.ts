/**
 * Generación multimedia del bloque `ai_media`.
 *
 * Audio: Edge-TTS (gratis, servicio no oficial de Microsoft) con
 * respaldo automático a OpenAI TTS. Imagen: Pollinations.ai (gratis) o
 * Together/Flux/OpenAI con clave de la cuenta.
 *
 * El resultado se sube a `flow-media` y se devuelve la URL pública para
 * guardarla en `vars.ai_media_url`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "@/lib/ai/config";
import { generateReply } from "@/lib/ai/generate";
import { decrypt } from "@/lib/whatsapp/encryption";
import { cargarDatosFichas, sustituirFichas } from "./bloques";
import type {
  AiMediaNodeConfig,
  AiMediaAudioConfig,
  AiMediaImageConfig,
} from "./types";

export interface MediaGenerada {
  url: string;
  mime: string;
  kind: "audio" | "image";
  provider: string;
}

interface MediaConfigRow {
  image_provider: string | null;
  image_api_key: string | null;
  image_model: string | null;
  audio_provider: string | null;
  audio_api_key: string | null;
  audio_model: string | null;
  default_voice: string | null;
}

const EDGE_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_TIMEOUT_MS = 30_000;

function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** true por defecto; se apaga con AI_MEDIA_EDGE_TTS=off. */
export function edgeTtsActivo(): boolean {
  return process.env.AI_MEDIA_EDGE_TTS !== "off";
}

/**
 * Sintetiza con el WebSocket de Edge. No usa claves ni paquetes
 * nativos. Si el formato OGG no devuelve audio, reintenta MP3.
 */
export async function generarAudioEdge(args: {
  texto: string;
  voice: string;
  format: "mp3" | "ogg";
}): Promise<{ buffer: Buffer; mime: string }> {
  const intentar = async (formato: "mp3" | "ogg") =>
    sintetizarEdge(args.texto, args.voice, formato);

  if (args.format === "ogg") {
    const ogg = await intentar("ogg").catch(() => null);
    if (ogg && ogg.buffer.length > 0) return ogg;
  }
  return intentar("mp3");
}

async function sintetizarEdge(
  texto: string,
  voice: string,
  formato: "mp3" | "ogg",
): Promise<{ buffer: Buffer; mime: string }> {
  const outputFormat =
    formato === "ogg"
      ? "ogg-24khz-16bit-mono-opus"
      : "audio-24khz-48kbitrate-mono-mp3";
  const mime = formato === "ogg" ? "audio/ogg" : "audio/mpeg";
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">` +
    `<voice name="${voice}"><prosody rate="0%" pitch="0%">${escaparXml(texto)}</prosody></voice>` +
    `</speak>`;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let terminado = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ws = new WebSocket(`${EDGE_URL}?TrustedClientToken=${EDGE_TOKEN}`);
    ws.binaryType = "arraybuffer";

    const cerrar = (error?: Error) => {
      if (terminado) return;
      terminado = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
      if (error) reject(error);
      else resolve({ buffer: Buffer.concat(chunks), mime });
    };

    timer = setTimeout(
      () => cerrar(new Error("Edge-TTS agotó el tiempo de espera.")),
      EDGE_TIMEOUT_MS,
    );

    ws.onopen = () => {
      const config =
        `X-Timestamp:${new Date().toString()}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false" },
                outputFormat,
              },
            },
          },
        });
      ws.send(config);
      ws.send(
        `X-RequestId:${crypto.randomUUID()}\r\n` +
          "Content-Type:application/ssml+xml\r\n" +
          `X-Timestamp:${new Date().toString()}Z\r\n` +
          "Path:ssml\r\n\r\n" +
          ssml,
      );
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) cerrar();
        return;
      }
      const buffer = Buffer.from(event.data as ArrayBuffer);
      if (buffer.length < 2) return;
      const headerLen = buffer.readUInt16BE(0);
      if (buffer.length < 2 + headerLen) return;
      const header = buffer.subarray(2, 2 + headerLen).toString("utf8");
      if (header.includes("Path:audio")) {
        const audio = buffer.subarray(2 + headerLen);
        if (audio.length > 0) chunks.push(audio);
      }
    };

    ws.onerror = () => cerrar(new Error("Edge-TTS no está disponible."));
    ws.onclose = () => cerrar();
  });
}

/** OpenAI TTS oficial (requiere clave de la cuenta o OPENAI_API_KEY). */
export async function generarAudioOpenAi(args: {
  texto: string;
  voice: string;
  apiKey: string;
  model?: string | null;
}): Promise<{ buffer: Buffer; mime: string }> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model || "gpt-4o-mini-tts",
      voice: args.voice || "alloy",
      input: args.texto,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI TTS respondió ${res.status}.`);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mime: "audio/mpeg",
  };
}

/** Pollinations.ai: imagen gratis, sin clave. */
export async function generarImagenPollinations(args: {
  prompt: string;
  width?: number;
  height?: number;
  model?: string;
}): Promise<{ buffer: Buffer; mime: string }> {
  const width = Math.min(Math.max(args.width ?? 1024, 256), 1536);
  const height = Math.min(Math.max(args.height ?? 1024, 256), 1536);
  const seed = Math.floor(Math.random() * 1_000_000);
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(args.prompt)}` +
    `?width=${width}&height=${height}&nologo=true&model=${encodeURIComponent(
      args.model || "flux",
    )}&seed=${seed}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Pollinations respondió ${res.status}.`);
  const mime = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  if (!mime.startsWith("image/")) {
    throw new Error("Pollinations no devolvió una imagen.");
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

/** Together/Flux/OpenAI: generación con clave de la cuenta. */
export async function generarImagenConClave(args: {
  provider: "together" | "flux" | "openai";
  prompt: string;
  apiKey: string;
  model?: string | null;
  width?: number;
  height?: number;
}): Promise<{ buffer: Buffer; mime: string }> {
  const endpoint =
    args.provider === "together" || args.provider === "flux"
      ? "https://api.together.xyz/v1/images/generations"
      : "https://api.openai.com/v1/images/generations";
  const model =
    args.model ||
    (args.provider === "together" || args.provider === "flux"
      ? "black-forest-labs/FLUX.1-schnell"
      : "gpt-image-1");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt: args.prompt,
      width: args.width ?? 1024,
      height: args.height ?? 1024,
      n: 1,
      response_format: "b64_json",
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`${args.provider} respondió ${res.status}.`);
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const item = json.data?.[0];
  if (item?.b64_json) {
    return { buffer: Buffer.from(item.b64_json, "base64"), mime: "image/png" };
  }
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) throw new Error("No se pudo descargar la imagen generada.");
    return {
      buffer: Buffer.from(await img.arrayBuffer()),
      mime: img.headers.get("content-type")?.split(";")[0] || "image/png",
    };
  }
  throw new Error("El proveedor de imagen no devolvió archivo.");
}

/** DeepSeek reescribe el prompt en inglés, sin texto en la imagen. */
export async function enriquecerPrompt(
  db: SupabaseClient,
  accountId: string,
  prompt: string,
): Promise<string> {
  try {
    const config = await loadAiConfig(db, accountId);
    if (!config) return prompt;
    const gen = await generateReply({
      config,
      systemPrompt:
        "Rewrite the user's idea as a vivid, concrete English image-generation prompt. " +
        "Describe subject, composition, lighting and style. No text, no logos, no watermarks. " +
        "Return only the prompt, max 60 words.",
      messages: [{ role: "user", content: prompt }],
    });
    const limpio = gen.text.replace(/^["'`]+|["'`]+$/g, "").trim();
    return limpio || prompt;
  } catch {
    return prompt;
  }
}

function extensionDe(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

/** Sube el archivo generado a `flow-media` y devuelve su URL pública. */
export async function subirMediaIA(
  db: SupabaseClient,
  accountId: string,
  buffer: Buffer,
  mime: string,
  kind: "audio" | "image",
): Promise<string> {
  const ext = extensionDe(mime);
  const path = `account-${accountId}/ai-media/${Date.now()}-${kind}-${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from("flow-media").upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) throw new Error(`No se pudo guardar el archivo generado: ${error.message}`);
  const { data } = db.storage.from("flow-media").getPublicUrl(path);
  return data.publicUrl;
}

async function cargarConfigMedia(
  db: SupabaseClient,
  accountId: string,
): Promise<MediaConfigRow | null> {
  const { data } = await db
    .from("ai_media_configs")
    .select(
      "image_provider, image_api_key, image_model, audio_provider, audio_api_key, audio_model, default_voice",
    )
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as MediaConfigRow | null) ?? null;
}

/** Texto/prompt con fichas de contacto y variables. */
async function interpolar(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    vars: Record<string, unknown>;
    texto: string;
  },
): Promise<string> {
  const datos = await cargarDatosFichas(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    vars: args.vars,
    textos: [args.texto],
  });
  return sustituirFichas(args.texto, datos);
}

/** Orquesta la generación completa del nodo. */
export async function generarMediaIA(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    vars: Record<string, unknown>;
    cfg: AiMediaNodeConfig;
  },
): Promise<MediaGenerada> {
  const config = await cargarConfigMedia(db, args.accountId);

  if (args.cfg.kind === "audio") {
    const audio: AiMediaAudioConfig = args.cfg.audio ?? {
      provider: "edge",
      voice: config?.default_voice || "es-MX-DaliaNeural",
      text: "",
      format: "mp3",
    };
    const texto = (await interpolar(db, {
      accountId: args.accountId,
      contactId: args.contactId,
      vars: args.vars,
      texto: audio.text,
    })).trim();
    if (!texto) throw new Error("El bloque de audio no tiene texto.");
    if (texto.length > 3000) throw new Error("El texto de audio supera 3000 caracteres.");

    const provider = audio.provider || (config?.audio_provider as "edge" | "openai") || "edge";
    let generado: { buffer: Buffer; mime: string };
    if (provider === "openai") {
      const apiKey =
        (config?.audio_api_key ? safeDecrypt(config.audio_api_key) : null) ||
        process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OpenAI TTS no tiene clave configurada.");
      generado = await generarAudioOpenAi({
        texto,
        voice: audio.voice || "alloy",
        apiKey,
        model: config?.audio_model,
      });
    } else if (edgeTtsActivo()) {
      try {
        generado = await generarAudioEdge({
          texto,
          voice: audio.voice || "es-MX-DaliaNeural",
          format: audio.format || "mp3",
        });
      } catch (err) {
        const apiKey =
          (config?.audio_api_key ? safeDecrypt(config.audio_api_key) : null) ||
          process.env.OPENAI_API_KEY;
        if (!apiKey) throw err;
        generado = await generarAudioOpenAi({
          texto,
          voice: audio.voice || "alloy",
          apiKey,
          model: config?.audio_model,
        });
      }
    } else {
      const apiKey =
        (config?.audio_api_key ? safeDecrypt(config.audio_api_key) : null) ||
        process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Edge-TTS está apagado y no hay OpenAI TTS configurado.");
      generado = await generarAudioOpenAi({
        texto,
        voice: audio.voice || "alloy",
        apiKey,
        model: config?.audio_model,
      });
    }

    const url = await subirMediaIA(db, args.accountId, generado.buffer, generado.mime, "audio");
    return { url, mime: generado.mime, kind: "audio", provider };
  }

  const image: AiMediaImageConfig = args.cfg.image ?? {
    provider: "pollinations",
    prompt: "",
  };
  let prompt = (await interpolar(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    vars: args.vars,
    texto: image.prompt,
  })).trim();
  if (!prompt) throw new Error("El bloque de imagen no tiene prompt.");
  if (image.enhance_prompt) {
    prompt = await enriquecerPrompt(db, args.accountId, prompt);
  }

  const provider =
    image.provider || (config?.image_provider as AiMediaImageConfig["provider"]) || "pollinations";
  let generado: { buffer: Buffer; mime: string };
  if (provider === "pollinations") {
    generado = await generarImagenPollinations({
      prompt,
      width: image.width,
      height: image.height,
      model: image.model || config?.image_model || "flux",
    });
  } else {
    const apiKey =
      (config?.image_api_key ? safeDecrypt(config.image_api_key) : null) ||
      (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.TOGETHER_API_KEY);
    if (!apiKey) throw new Error(`El proveedor de imagen ${provider} no tiene clave.`);
    generado = await generarImagenConClave({
      provider,
      prompt,
      apiKey,
      model: image.model || config?.image_model,
      width: image.width,
      height: image.height,
    });
  }

  const url = await subirMediaIA(db, args.accountId, generado.buffer, generado.mime, "image");
  return { url, mime: generado.mime, kind: "image", provider };
}

function safeDecrypt(valor: string): string | null {
  try {
    return decrypt(valor);
  } catch {
    return null;
  }
}
