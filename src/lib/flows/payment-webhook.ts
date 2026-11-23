/**
 * Webhooks de la Pasarela de Pagos.
 *
 * Verifica la firma de cada proveedor antes de confiar en el payload.
 * Stripe/Whop/Mercado Pago usan HMAC con tolerancia de 5 minutos;
 * Hotmart usa el hottok compartido; SPEI solo se confirma a mano (o
 * con un secreto genérico si se conecta un agregador).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/whatsapp/encryption";
import { registrarVentaDeSesionAprobada, resumePaymentGateway } from "./engine";
import {
  correoNormalizado,
  eventoDesdePayload,
  montoCoincide,
  pagoMercadoPago,
  type EventoPago,
} from "./pagos";
import type { PaymentCurrency, PaymentProvider } from "./types";

const TOLERANCIA_SEG = 300;

function igualSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function hexHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Stripe: `t=...,v1=...` sobre `${t}.${rawBody}`. */
export function firmaStripeValida(args: {
  header: string | null;
  rawBody: string;
  secret: string;
  ahora?: number;
}): boolean {
  if (!args.header) return false;
  const partes = args.header.split(",").reduce<Record<string, string[]>>((acc, p) => {
    const idx = p.indexOf("=");
    if (idx < 0) return acc;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    (acc[k] ??= []).push(v);
    return acc;
  }, {});
  const t = Number(partes.t?.[0]);
  if (!Number.isFinite(t)) return false;
  if (Math.abs((args.ahora ?? Date.now() / 1000) - t) > TOLERANCIA_SEG) return false;
  const esperada = hexHmac(args.secret, `${t}.${args.rawBody}`);
  return (partes.v1 ?? []).some((v) => igualSeguro(esperada, v));
}

/** Whop / Standard Webhooks: `webhook-id.timestamp.rawBody`, base64. */
export function firmaWhopValida(args: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret: string;
  ahora?: number;
}): boolean {
  if (!args.id || !args.timestamp || !args.signature) return false;
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs((args.ahora ?? Date.now() / 1000) - ts) > TOLERANCIA_SEG) return false;
  // Whop usa Standard Webhooks con secreto `ws_<base64>`; la clave HMAC
  // es el base64 decodificado, no el string completo.
  const base = args.secret.startsWith("ws_") ? args.secret.slice(3) : args.secret;
  const key = Buffer.from(base, "base64");
  const esperada = createHmac("sha256", key.length > 0 ? key : args.secret)
    .update(`${args.id}.${args.timestamp}.${args.rawBody}`)
    .digest("base64");
  return args.signature
    .split(" ")
    .map((s) => s.replace(/^v1,/, ""))
    .some((s) => igualSeguro(esperada, s));
}

/** Mercado Pago: manifiesto `id:...;request-id:...;ts:...;`. */
export function firmaMercadoPagoValida(args: {
  signature: string | null;
  requestId: string | null;
  dataId: string;
  secret: string;
  ahora?: number;
}): boolean {
  if (!args.signature) return false;
  const partes = args.signature.split(",").reduce<Record<string, string>>((acc, p) => {
    const idx = p.indexOf("=");
    if (idx < 0) return acc;
    acc[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    return acc;
  }, {});
  const ts = Number(partes.ts);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs((args.ahora ?? Date.now() / 1000) - ts) > TOLERANCIA_SEG) return false;
  const manifiesto = [
    `id:${args.dataId}`,
    args.requestId ? `request-id:${args.requestId}` : null,
    `ts:${partes.ts}`,
  ]
    .filter(Boolean)
    .join(";") + ";";
  const esperada = hexHmac(args.secret, manifiesto);
  return igualSeguro(esperada, partes.v1 ?? "");
}

/** Hotmart: comparación en tiempo constante del hottok. */
export function firmaHotmartValida(header: string | null, secret: string): boolean {
  if (!header) return false;
  return igualSeguro(header.trim(), secret.trim());
}

/** SPEI (agregador propio): HMAC hex del body. */
export function firmaSpeiValida(args: {
  header: string | null;
  rawBody: string;
  secret: string;
}): boolean {
  if (!args.header) return false;
  return igualSeguro(hexHmac(args.secret, args.rawBody), args.header.trim());
}

interface ConfigPasarela {
  webhook_secret: string | null;
  api_key: string | null;
}

async function configDeCuenta(
  db: SupabaseClient,
  accountId: string,
  provider: PaymentProvider,
): Promise<ConfigPasarela | null> {
  const { data } = await db
    .from("payment_gateway_configs")
    .select("webhook_secret, api_key")
    .eq("account_id", accountId)
    .eq("provider", provider)
    .eq("active", true)
    .maybeSingle();
  return (data as ConfigPasarela | null) ?? null;
}

function secreto(valor: string | null | undefined): string | null {
  if (!valor) return null;
  try {
    return decrypt(valor);
  } catch {
    return null;
  }
}

interface SesionPago {
  id: string;
  account_id: string;
  flow_run_id: string;
  provider: string;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  contact_id: string | null;
  contact?: { email?: string | null } | null;
}

async function buscarSesion(
  db: SupabaseClient,
  args: {
    accountId: string;
    provider: PaymentProvider;
    event: EventoPago;
  },
): Promise<SesionPago | null> {
  if (args.event.reference) {
    const { data } = await db
      .from("flow_payment_sessions")
      .select("id, account_id, flow_run_id, provider, reference, amount, currency, status, contact_id, contact:contacts(email)")
      .eq("account_id", args.accountId)
      .eq("provider", args.provider)
      .eq("reference", args.event.reference)
      .maybeSingle();
    if (data) return data as unknown as SesionPago;
  }

  const email = correoNormalizado(args.event.email);
  if (!email) return null;
  const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await db
    .from("flow_payment_sessions")
    .select("id, account_id, flow_run_id, provider, reference, amount, currency, status, contact_id, contact:contacts(email)")
    .eq("account_id", args.accountId)
    .eq("provider", args.provider)
    .eq("status", "pending")
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(20);
  for (const fila of (data ?? []) as unknown as SesionPago[]) {
    const correoSesion = correoNormalizado(fila.contact?.email);
    if (correoSesion !== email) continue;
    if (!montoCoincide(Number(fila.amount), args.event.amount)) continue;
    if (
      args.event.currency &&
      String(fila.currency).toUpperCase() !== String(args.event.currency).toUpperCase()
    ) {
      continue;
    }
    return fila;
  }
  return null;
}

export interface ResultadoWebhook {
  status: number;
  body: Record<string, unknown>;
}

export async function procesarWebhookPago(args: {
  db: SupabaseClient;
  provider: PaymentProvider;
  rawBody: string;
  headers: Headers;
  /** `?account=<uuid>` del URL registrado en la pasarela. */
  accountId: string | null;
}): Promise<ResultadoWebhook> {
  const { db, provider, rawBody, headers } = args;
  const config = args.accountId ? await configDeCuenta(db, args.accountId, provider) : null;
  if (!config) {
    return { status: 400, body: { error: "gateway_not_configured" } };
  }
  const webhookSecret = secreto(config.webhook_secret);
  if (!webhookSecret && provider !== "spei") {
    return { status: 400, body: { error: "webhook_secret_missing" } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  if (provider === "stripe") {
    if (
      !firmaStripeValida({
        header: headers.get("stripe-signature"),
        rawBody,
        secret: webhookSecret!,
      })
    ) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  } else if (provider === "whop") {
    if (
      !firmaWhopValida({
        id: headers.get("webhook-id"),
        timestamp: headers.get("webhook-timestamp"),
        signature: headers.get("webhook-signature"),
        rawBody,
        secret: webhookSecret!,
      })
    ) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  } else if (provider === "hotmart") {
    if (!firmaHotmartValida(headers.get("x-hotmart-hottok"), webhookSecret!)) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  } else if (provider === "spei") {
    if (
      webhookSecret &&
      !firmaSpeiValida({
        header: headers.get("x-spei-signature"),
        rawBody,
        secret: webhookSecret,
      })
    ) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  } else if (provider === "mercadopago") {
    const dataId = String(
      (payload.data as { id?: string } | undefined)?.id ?? payload.id ?? "",
    );
    if (
      !firmaMercadoPagoValida({
        signature: headers.get("x-signature"),
        requestId: headers.get("x-request-id"),
        dataId,
        secret: webhookSecret!,
      })
    ) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  }

  let evento = eventoDesdePayload(provider, payload, headers.get("webhook-id"));

  // Mercado Pago manda solo el id: el estado real está en la API.
  if (provider === "mercadopago") {
    const dataId = String(
      (payload.data as { id?: string } | undefined)?.id ?? payload.id ?? "",
    );
    const accessToken = secreto(config.api_key);
    if (!dataId || !accessToken) {
      return { status: 400, body: { error: "payment_lookup_failed" } };
    }
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { status: 502, body: { error: "mercadopago_lookup_failed" } };
    }
    const pago = (await res.json()) as Record<string, unknown>;
    const normalizado = pagoMercadoPago(pago);
    evento = {
      ...evento,
      status: normalizado.status,
      amount: normalizado.amount,
      currency: normalizado.currency,
      externalId: normalizado.externalId,
      reference: normalizado.reference ?? evento.reference,
      email: normalizado.email ?? evento.email,
      eventId: `${String(payload.type ?? "payment")}:${dataId}`,
      raw: { webhook: payload, payment: pago },
    };
  }

  let accountId = args.accountId;
  if (!accountId && evento.reference) {
    const { data } = await db
      .from("flow_payment_sessions")
      .select("account_id")
      .eq("reference", evento.reference)
      .maybeSingle();
    accountId = (data as { account_id?: string } | null)?.account_id ?? null;
  }
  if (!accountId) {
    return { status: 400, body: { error: "account_not_resolved" } };
  }

  const { error: dupErr } = await db.from("payment_webhook_events").insert({
    account_id: accountId,
    provider,
    event_id: evento.eventId,
    reference: evento.reference,
    payload: evento.raw,
  });
  if (dupErr?.code === "23505") {
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  if (dupErr) {
    return { status: 500, body: { error: dupErr.message } };
  }

  const sesion = await buscarSesion(db, {
    accountId,
    provider,
    event: evento,
  });
  if (!sesion) {
    return { status: 200, body: { ok: true, ignored: "session_not_found" } };
  }

  if (evento.status === "approved") {
    if (!montoCoincide(Number(sesion.amount), evento.amount)) {
      return { status: 200, body: { ok: true, ignored: "amount_mismatch" } };
    }
    if (
      evento.currency &&
      String(sesion.currency).toUpperCase() !== String(evento.currency).toUpperCase()
    ) {
      return { status: 200, body: { ok: true, ignored: "currency_mismatch" } };
    }
  }

  const nuevoEstado =
    evento.status === "approved"
      ? "approved"
      : evento.status === "rejected"
        ? "rejected"
        : "pending";
  await db
    .from("flow_payment_sessions")
    .update({
      status: nuevoEstado,
      external_id: evento.externalId,
      approved_at: evento.status === "approved" ? new Date().toISOString() : null,
      metadata: { ...evento.raw, provider_event: evento.eventId },
      updated_at: new Date().toISOString(),
    })
    .eq("id", sesion.id)
    .eq("status", "pending");

  if (evento.status === "pending") {
    return { status: 200, body: { ok: true, pending: true } };
  }

  const { data: runRow } = await db
    .from("flow_runs")
    .select("vars")
    .eq("id", sesion.flow_run_id)
    .maybeSingle();
  const vars = {
    ...((runRow as { vars?: Record<string, unknown> } | null)?.vars ?? {}),
    __payment_amount: sesion.amount,
    __payment_currency: sesion.currency as PaymentCurrency,
    __payment_external_id: evento.externalId,
    __payment_status: nuevoEstado,
  };
  await db
    .from("flow_runs")
    .update({
      vars,
      next_run_at: new Date().toISOString(),
      resume_reason: "payment_gateway",
    })
    .eq("id", sesion.flow_run_id)
    .eq("status", "active");

  const reanudada = await resumePaymentGateway(db, {
    runId: sesion.flow_run_id,
    decision: evento.status === "approved" ? "approved" : "rejected",
    sessionId: sesion.id,
  });
  if (!reanudada && evento.status === "approved") {
    // Pago tardío: la corrida ya salió por timeout. La venta se registra
    // igual (deal/CAPI) para no perder el ingreso.
    await registrarVentaDeSesionAprobada(db, sesion.id);
  }

  return {
    status: 200,
    body: {
      ok: true,
      status: nuevoEstado,
      session_id: sesion.id,
      run_resumed: reanudada,
    },
  };
}
