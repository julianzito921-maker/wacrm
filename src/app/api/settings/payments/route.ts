import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";
import { urlBaseWebhook } from "@/lib/flows/pagos";
import { PAYMENT_PROVIDERS, type PaymentProvider } from "@/lib/flows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esProveedor(valor: string): valor is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(valor);
}

interface FilaConfig {
  provider: PaymentProvider;
  webhook_secret: string | null;
  api_key: string | null;
  config: Record<string, unknown> | null;
  active: boolean;
}

function publica(fila: FilaConfig, origin: string, accountId: string) {
  return {
    provider: fila.provider,
    has_webhook_secret: Boolean(fila.webhook_secret),
    has_api_key: Boolean(fila.api_key),
    config: fila.config ?? {},
    active: fila.active,
    webhook_url: `${origin}/api/webhooks/payments/${fila.provider}?account=${accountId}`,
  };
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { data, error } = await supabase
      .from("payment_gateway_configs")
      .select("provider, webhook_secret, api_key, config, active")
      .eq("account_id", accountId);
    if (error) throw new Error(error.message);
    const origin = urlBaseWebhook(request);
    const porProveedor = new Map(
      ((data ?? []) as FilaConfig[]).map((f) => [f.provider, f]),
    );
    const proveedores = PAYMENT_PROVIDERS.map((provider) => {
      const fila = porProveedor.get(provider);
      return fila
        ? publica(fila, origin, accountId)
        : {
            provider,
            has_webhook_secret: false,
            has_api_key: false,
            config: {},
            active: false,
            webhook_url: `${origin}/api/webhooks/payments/${provider}?account=${accountId}`,
          };
    });
    return NextResponse.json({ providers: proveedores });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const body = (await request.json().catch(() => ({}))) as {
      provider?: string;
      webhook_secret?: string;
      api_key?: string;
      config?: Record<string, unknown>;
      active?: boolean;
    };
    const provider = String(body.provider ?? "");
    if (!esProveedor(provider)) {
      return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
    }

    const { data: actual } = await supabase
      .from("payment_gateway_configs")
      .select("webhook_secret, api_key, config, active")
      .eq("account_id", accountId)
      .eq("provider", provider)
      .maybeSingle();
    const fila = actual as FilaConfig | null;

    const patch: Record<string, unknown> = {
      account_id: accountId,
      provider,
      active: body.active ?? fila?.active ?? true,
      config: body.config ?? fila?.config ?? {},
      updated_at: new Date().toISOString(),
    };
    if (typeof body.webhook_secret === "string" && body.webhook_secret.trim()) {
      patch.webhook_secret = encrypt(body.webhook_secret.trim());
    }
    if (typeof body.api_key === "string" && body.api_key.trim()) {
      patch.api_key = encrypt(body.api_key.trim());
    }

    const { error } = await supabase
      .from("payment_gateway_configs")
      .upsert(patch, { onConflict: "account_id,provider" });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
