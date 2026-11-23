import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { procesarWebhookPago } from "@/lib/flows/payment-webhook";
import { PAYMENT_PROVIDERS, type PaymentProvider } from "@/lib/flows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esProveedor(valor: string): valor is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(valor);
}

export async function GET() {
  return NextResponse.json({ ok: true });
}

/**
 * Receptor de webhooks de pasarelas.
 *
 * URL a registrar en cada proveedor:
 *   /api/webhooks/payments/<provider>?account=<uuid>
 *
 * El `account` es un identificador público (no un secreto) y permite
 * buscar la clave HMAC correcta en cuentas multi-tenant. La firma se
 * valida SIEMPRE antes de leer el JSON.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  if (!esProveedor(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
  }

  const rawBody = await request.text();
  const accountId = new URL(request.url).searchParams.get("account");

  try {
    const resultado = await procesarWebhookPago({
      db: supabaseAdmin(),
      provider,
      rawBody,
      headers: request.headers,
      accountId,
    });
    return NextResponse.json(resultado.body, { status: resultado.status });
  } catch (err) {
    console.error(
      "[payments/webhook] error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "webhook_failed" }, { status: 500 });
  }
}
