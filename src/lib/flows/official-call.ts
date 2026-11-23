/**
 * Llamada Oficial (WhatsApp Business Calling API).
 *
 * No hay atajos: se usan los endpoints oficiales de Meta para permiso
 * y settings. La llamada real solo se dispara si la cuenta tiene un
 * puente SIP configurado; si no, el bloque entrega al agente.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/whatsapp/encryption";
import {
  getCallPermissions,
  getCallSettings,
  sendCallPermissionRequest,
  sendTemplateMessage,
  type CallPermissionState,
} from "@/lib/whatsapp/meta-api";
import type { ConnectionCredentials } from "@/lib/whatsapp/connections";
import { OFFICIAL_CALL_EXCLUDED_COUNTRIES } from "./types";

export interface DisponibilidadLlamadas {
  country: string | null;
  supported: boolean;
  reason:
    | "ok"
    | "pais_no_soportado"
    | "sin_numero"
    | "calling_deshabilitado"
    | "sin_limite_2000"
    | "restringido";
  detail?: string;
}

/** Prefijos de país que nos interesan para el aviso de disponibilidad. */
const PREFIJOS: Array<{ code: string; iso: string }> = [
  { code: "52", iso: "MX" },
  { code: "1", iso: "US" }, // EE. UU./Canadá: ambos excluidos
  { code: "20", iso: "EG" },
  { code: "84", iso: "VN" },
  { code: "234", iso: "NG" },
  { code: "55", iso: "BR" },
  { code: "54", iso: "AR" },
  { code: "57", iso: "CO" },
  { code: "56", iso: "CL" },
  { code: "51", iso: "PE" },
  { code: "34", iso: "ES" },
];

export function paisDeTelefono(telefono: string | null | undefined): string | null {
  const digitos = String(telefono ?? "").replace(/\D/g, "");
  if (!digitos) return null;
  for (const p of PREFIJOS) {
    if (digitos.startsWith(p.code)) return p.iso;
  }
  return null;
}

/** Aviso previo por país. La comprobación real es GET /settings. */
export function disponibilidadPorPais(
  telefono: string | null | undefined,
  messagingLimit?: string | null,
): DisponibilidadLlamadas {
  const country = paisDeTelefono(telefono);
  if (!country) {
    return { country: null, supported: false, reason: "sin_numero" };
  }
  if (OFFICIAL_CALL_EXCLUDED_COUNTRIES.includes(country)) {
    return {
      country,
      supported: false,
      reason: "pais_no_soportado",
      detail:
        "Meta no permite llamadas iniciadas por el negocio desde números de EE. UU., Canadá, Egipto, Vietnam o Nigeria.",
    };
  }
  if (String(messagingLimit ?? "").toLowerCase().includes("1k") || String(messagingLimit ?? "").includes("1,000")) {
    return {
      country,
      supported: false,
      reason: "sin_limite_2000",
      detail: "Se necesita un límite de mensajería de 2.000 o más para habilitar llamadas.",
    };
  }
  return { country, supported: true, reason: "ok" };
}

/** Interpreta `GET /settings` y detecta bloqueos de Meta. */
export function estadoDesdeSettings(
  settings: Awaited<ReturnType<typeof getCallSettings>>,
): DisponibilidadLlamadas {
  const calling = settings.calling;
  if (!calling) {
    return { country: null, supported: false, reason: "calling_deshabilitado" };
  }
  if (String(calling.status ?? "").toLowerCase() !== "enabled") {
    return {
      country: null,
      supported: false,
      reason: "calling_deshabilitado",
      detail: "Calling no está habilitado en este número de WhatsApp Business.",
    };
  }
  const restricciones = calling.restrictions?.restrictions_list ?? [];
  const bloqueo = restricciones.find((r) =>
    r.type?.includes("BUSINESS_INITIATED"),
  );
  if (bloqueo) {
    return {
      country: null,
      supported: false,
      reason: "restringido",
      detail: bloqueo.reason || "Llamadas restringidas temporalmente por Meta.",
    };
  }
  return { country: null, supported: true, reason: "ok" };
}

/** Consulta y cachea el estado de calling de una conexión. */
export async function refrescarEstadoLlamadas(
  db: SupabaseClient,
  args: { accountId: string; connectionId: string; creds: ConnectionCredentials },
): Promise<Awaited<ReturnType<typeof getCallSettings>>> {
  const settings = await getCallSettings({
    phoneNumberId: args.creds.phoneNumberId,
    accessToken: args.creds.accessToken,
  });
  await db.from("whatsapp_calling_configs").upsert(
    {
      connection_id: args.connectionId,
      account_id: args.accountId,
      calling_status: settings.calling ?? {},
      checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" },
  );
  return settings;
}

export interface RespuestaPermiso {
  response: "accept" | "reject";
  is_permanent: boolean;
  expiration_timestamp?: number | null;
  context_id?: string | null;
}

/** Extrae la respuesta de permiso del payload interactivo de Meta. */
export function interpretarPermisoLlamada(
  interactive: Record<string, unknown> | null | undefined,
): RespuestaPermiso | null {
  const reply = interactive?.call_permission_reply as
    | {
        response?: unknown;
        is_permanent?: unknown;
        expiration_timestamp?: unknown;
      }
    | undefined;
  if (!reply) return null;
  const response = reply.response === "accept" ? "accept" : reply.response === "reject" ? "reject" : null;
  if (!response) return null;
  return {
    response,
    is_permanent: reply.is_permanent === true,
    expiration_timestamp:
      typeof reply.expiration_timestamp === "number"
        ? reply.expiration_timestamp
        : reply.expiration_timestamp
          ? Number(reply.expiration_timestamp)
          : null,
  };
}

export interface ResultadoPermiso {
  /** wamid del mensaje de solicitud, si Meta lo devolvió. */
  messageId: string | null;
  permiso: CallPermissionState | null;
  via: "texto" | "plantilla" | "ya_concedido";
}

/**
 * Solicita permiso de llamada. Si ya hay permiso, no manda nada.
 * Si la ventana está cerrada y hay plantilla, usa la plantilla.
 */
export async function solicitarPermisoLlamada(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string | null;
    creds: ConnectionCredentials;
    userWaId: string;
    bodyText: string;
    templateName?: string;
    templateLanguage?: string;
    templateVariables?: Record<string, string>;
    ventanaAbierta: boolean;
  },
): Promise<ResultadoPermiso> {
  const permiso = await getCallPermissions({
    phoneNumberId: args.creds.phoneNumberId,
    accessToken: args.creds.accessToken,
    userWaId: args.userWaId,
  }).catch(() => null);

  const status = permiso?.permission?.status;
  if (status === "temporary" || status === "permanent") {
    return { messageId: null, permiso, via: "ya_concedido" };
  }

  if (!args.ventanaAbierta) {
    if (!args.templateName) {
      throw new Error(
        "La ventana de 24 h está cerrada y no hay plantilla de permiso configurada.",
      );
    }
    const variables = args.templateVariables ?? {};
    const params = Object.keys(variables)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => variables[k]);
    const result = await sendTemplateMessage({
      phoneNumberId: args.creds.phoneNumberId,
      accessToken: args.creds.accessToken,
      to: args.userWaId,
      templateName: args.templateName,
      language: args.templateLanguage || "es_MX",
      params,
    });
    return { messageId: result.messageId, permiso, via: "plantilla" };
  }

  const result = await sendCallPermissionRequest({
    phoneNumberId: args.creds.phoneNumberId,
    accessToken: args.creds.accessToken,
    to: args.userWaId,
    bodyText: args.bodyText,
  });
  return { messageId: result.messageId, permiso, via: "texto" };
}

export interface PuenteSip {
  bridgeUrl: string;
  bridgeSecret: string | null;
}

/** Carga el puente SIP configurado para una conexión, si existe. */
export async function cargarPuenteSip(
  db: SupabaseClient,
  connectionId: string | null | undefined,
): Promise<PuenteSip | null> {
  if (!connectionId) return null;
  const { data } = await db
    .from("whatsapp_calling_configs")
    .select("bridge_url, bridge_secret, bridge_enabled")
    .eq("connection_id", connectionId)
    .maybeSingle();
  const row = data as {
    bridge_url?: string | null;
    bridge_secret?: string | null;
    bridge_enabled?: boolean;
  } | null;
  if (!row?.bridge_enabled || !row.bridge_url) return null;
  let secret: string | null = null;
  if (row.bridge_secret) {
    try {
      secret = decrypt(row.bridge_secret);
    } catch {
      secret = null;
    }
  }
  return { bridgeUrl: row.bridge_url, bridgeSecret: secret };
}

/**
 * Dispara el puente SIP. El puente hace el INVITE oficial a
 * `sip:+<numero>@wa.meta.vc;transport=tls`; el CRM no habla SIP.
 */
export async function dispararPuenteSip(args: {
  puente: PuenteSip;
  phoneNumberId: string;
  to: string;
  reference: string;
}): Promise<{ ok: boolean; status: number; detalle?: string }> {
  const payload = JSON.stringify({
    phone_number_id: args.phoneNumberId,
    to: args.to,
    reference: args.reference,
    requested_at: new Date().toISOString(),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.puente.bridgeSecret) {
    headers["x-signature"] = createHmac("sha256", args.puente.bridgeSecret)
      .update(payload)
      .digest("hex");
  }
  const res = await fetch(args.puente.bridgeUrl, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const detalle = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, detalle: detalle.slice(0, 300) };
}

/** Comparación en tiempo constante para secretos del puente. */
export function firmaValida(esperada: string, recibida: string): boolean {
  const a = Buffer.from(esperada);
  const b = Buffer.from(recibida);
  return a.length === b.length && timingSafeEqual(a, b);
}
