/**
 * Normalización de eventos de pasarelas.
 *
 * Cada proveedor manda un payload distinto. Todo lo específico se
 * reduce aquí a `EventoPago`; el motor y el webhook solo ven estados
 * normalizados. Funciones puras para poder probarlas con fixtures.
 */

import { randomBytes } from "node:crypto";
import type { PaymentCurrency, PaymentProvider } from "./types";

export type EstadoPago = "approved" | "rejected" | "pending";

export interface EventoPago {
  provider: PaymentProvider;
  /** Id idempotente del evento o de la transacción. */
  eventId: string;
  /** Referencia de la sesión (`flow_payment_sessions.reference`). */
  reference: string | null;
  status: EstadoPago;
  amount: number | null;
  currency: PaymentCurrency | null;
  externalId: string | null;
  /** Correo del comprador, para la correlación de respaldo. */
  email: string | null;
  raw: Record<string, unknown>;
}

export interface PagoNormalizado {
  status: EstadoPago;
  amount: number | null;
  currency: PaymentCurrency | null;
  externalId: string | null;
  reference: string | null;
  email: string | null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function texto(...valores: unknown[]): string | null {
  for (const v of valores) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function numero(...valores: unknown[]): number | null {
  for (const v of valores) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function moneda(valor: unknown): PaymentCurrency | null {
  const m = texto(valor)?.toUpperCase();
  if (m === "MXN" || m === "USD") return m;
  return null;
}

/** Referencia corta y única por corrida. */
export function generarReferencia(provider: PaymentProvider): string {
  return `pay_${provider}_${randomBytes(8).toString("hex")}`;
}

/** Moneda normalizada de un pago o de la cuenta. */
export function monedaDePago(valor: unknown, porDefecto: PaymentCurrency = "MXN"): PaymentCurrency {
  return moneda(valor) ?? porDefecto;
}

// ============================================================
// Stripe
// ============================================================
export function eventoStripe(payload: Record<string, unknown>): EventoPago {
  const type = texto(payload.type) ?? "";
  const object = obj(obj(payload.data).object);
  const status: EstadoPago =
    type === "checkout.session.completed" && texto(object.payment_status) === "paid"
      ? "approved"
      : type === "checkout.session.async_payment_succeeded" ||
          type === "payment_intent.succeeded"
        ? "approved"
        : type === "checkout.session.async_payment_failed" ||
            type === "payment_intent.payment_failed" ||
            type === "charge.failed"
          ? "rejected"
          : "pending";
  const amountMinor = numero(object.amount_total, object.amount_received, object.amount);
  return {
    provider: "stripe",
    eventId: texto(payload.id) ?? texto(object.id) ?? `stripe_${Date.now()}`,
    reference:
      texto(object.client_reference_id, obj(object.metadata).payment_ref, obj(object.metadata).reference) ??
      null,
    status,
    amount: amountMinor === null ? null : amountMinor / 100,
    currency: moneda(object.currency),
    externalId: texto(object.payment_intent, object.id) ?? null,
    email: texto(obj(object.customer_details).email, object.customer_email) ?? null,
    raw: payload,
  };
}

// ============================================================
// Whop (Standard Webhooks)
// ============================================================
export function eventoWhop(
  payload: Record<string, unknown>,
  webhookId?: string | null,
): EventoPago {
  const type = texto(payload.type) ?? "";
  const data = obj(payload.data);
  const status: EstadoPago =
    type === "payment.succeeded"
      ? "approved"
      : type === "payment.failed" || type === "payment.canceled"
        ? "rejected"
        : "pending";
  return {
    provider: "whop",
    eventId: webhookId ?? texto(payload.id) ?? `whop_${Date.now()}`,
    reference:
      texto(
        obj(data.metadata).payment_ref,
        obj(data.metadata).reference,
        data.reference,
      ) ?? null,
    status,
    amount: numero(data.total, data.amount, data.subtotal) ?? null,
    currency: moneda(data.currency),
    externalId: texto(data.id, data.payment_id) ?? null,
    email: texto(obj(data.user).email, data.email) ?? null,
    raw: payload,
  };
}

// ============================================================
// Hotmart 2.0
// ============================================================
export function eventoHotmart(payload: Record<string, unknown>): EventoPago {
  const event = texto(payload.event) ?? "";
  const data = obj(payload.data);
  const purchase = obj(data.purchase);
  const statusCompra = (texto(purchase.status) ?? "").toUpperCase();
  const status: EstadoPago =
    (event === "PURCHASE_APPROVED" || event === "PURCHASE_COMPLETE") &&
    (statusCompra === "APPROVED" || statusCompra === "COMPLETE")
      ? "approved"
      : event === "PURCHASE_CANCELED" ||
          event === "PURCHASE_REFUNDED" ||
          event === "PURCHASE_CHARGEBACK" ||
          event === "PURCHASE_EXPIRED" ||
          event === "PURCHASE_PROTEST"
        ? "rejected"
        : "pending";
  const tracking = obj(purchase.tracking);
  const origin = obj(purchase.origin);
  const price = obj(purchase.price);
  const buyer = obj(data.buyer);
  return {
    provider: "hotmart",
    eventId:
      texto(payload.id, purchase.transaction) ?? `hotmart_${Date.now()}`,
    reference:
      texto(
        tracking.source_sck,
        tracking.source,
        origin.sck,
        purchase.external_reference,
      ) ?? null,
    status,
    amount: numero(price.value) ?? null,
    currency: moneda(price.currency_value),
    externalId: texto(purchase.transaction) ?? null,
    email: texto(buyer.email) ?? null,
    raw: payload,
  };
}

// ============================================================
// Mercado Pago
// ============================================================
/** El webhook solo trae el id; el pago real se consulta en la API. */
export function pagoMercadoPago(payload: Record<string, unknown>): PagoNormalizado {
  const statusRaw = (texto(payload.status) ?? "").toLowerCase();
  return {
    status:
      statusRaw === "approved"
        ? "approved"
        : statusRaw === "rejected" || statusRaw === "cancelled" || statusRaw === "canceled"
          ? "rejected"
          : "pending",
    amount: numero(payload.transaction_amount) ?? null,
    currency: moneda(payload.currency_id),
    externalId: texto(payload.id) ?? null,
    reference: texto(payload.external_reference) ?? null,
    email: texto(obj(payload.payer).email) ?? null,
  };
}

// ============================================================
// Despacho
// ============================================================
export function eventoDesdePayload(
  provider: PaymentProvider,
  payload: Record<string, unknown>,
  webhookId?: string | null,
): EventoPago {
  if (provider === "stripe") return eventoStripe(payload);
  if (provider === "whop") return eventoWhop(payload, webhookId);
  if (provider === "hotmart") return eventoHotmart(payload);
  if (provider === "spei") {
    const statusRaw = (texto(payload.status) ?? "").toLowerCase();
    return {
      provider: "spei",
      eventId: texto(payload.id, payload.reference) ?? `spei_${Date.now()}`,
      reference: texto(payload.reference, payload.external_reference) ?? null,
      status:
        statusRaw === "approved" || statusRaw === "pagado"
          ? "approved"
          : statusRaw === "rejected" || statusRaw === "rechazado"
            ? "rejected"
            : "pending",
      amount: numero(payload.amount, payload.monto) ?? null,
      currency: moneda(payload.currency) ?? moneda(payload.moneda),
      externalId: texto(payload.external_id, payload.id) ?? null,
      email: texto(payload.email) ?? null,
      raw: payload,
    };
  }
  const mp = pagoMercadoPago(payload);
  return {
    provider: "mercadopago",
    eventId: `${texto(payload.action, payload.type) ?? "payment"}:${texto(obj(payload.data).id, payload.id) ?? Date.now()}`,
    reference: mp.reference,
    status: mp.status,
    amount: mp.amount,
    currency: mp.currency,
    externalId: mp.externalId,
    email: mp.email,
    raw: payload,
  };
}

/** ¿El monto del evento coincide con la sesión? Tolerancia de 1 centavo. */
export function montoCoincide(
  esperado: number,
  recibido: number | null,
): boolean {
  if (recibido === null || !Number.isFinite(recibido)) return true;
  const a = Math.round(Number(esperado) * 100);
  const b = Math.round(Number(recibido) * 100);
  return Math.abs(a - b) <= 1;
}

/** Normaliza un correo para la correlación de respaldo. */
export function correoNormalizado(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim().toLowerCase();
  return limpio.includes("@") ? limpio : null;
}

/** Estados de la sesión que ya no se pueden cambiar. */
export function sesionCerrada(status: string): boolean {
  return status === "approved" || status === "rejected" || status === "expired" || status === "cancelled";
}

function esHostLocal(host: string): boolean {
  const nombre = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return nombre === "localhost" || nombre === "127.0.0.1" || nombre === "::1" || nombre.endsWith(".localhost");
}

/**
 * Base pública del URL que se registra en cada pasarela.
 *
 * Orden: `NEXT_PUBLIC_SITE_URL`; si falta, `X-Forwarded-Host` (+
 * `X-Forwarded-Proto`) que pone el proxy de Railway, como en
 * account/invitations; luego `Host`; y al final el origin del request
 * (que detrás del proxy es el interno). Fuera de localhost se fuerza
 * https: las pasarelas no aceptan (o no deben recibir) webhooks en http.
 */
export function urlBaseWebhook(request: Request): string {
  const explicito = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  let base: string;
  if (explicito) {
    base = explicito.replace(/\/+$/, "");
  } else {
    const primero = (v: string | null) => v?.split(",")[0]?.trim() || null;
    const fwdHost = primero(request.headers.get("x-forwarded-host"));
    const fwdProto = primero(request.headers.get("x-forwarded-proto"));
    const host = request.headers.get("host")?.trim() || null;
    const url = new URL(request.url);
    if (fwdHost) base = `${fwdProto || "https"}://${fwdHost}`;
    else if (host) base = `${url.protocol.replace(":", "")}://${host}`;
    else base = url.origin;
  }
  try {
    const u = new URL(base);
    if (u.protocol === "http:" && !esHostLocal(u.host)) u.protocol = "https:";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return base;
  }
}
