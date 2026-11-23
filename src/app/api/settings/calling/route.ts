import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Fila {
  connection_id: string;
  bridge_url: string | null;
  bridge_secret: string | null;
  bridge_enabled: boolean;
  calling_status: Record<string, unknown> | null;
  checked_at: string | null;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const [{ data: conexiones }, { data: configs }] = await Promise.all([
      supabase
        .from("whatsapp_connections")
        .select("id, name, phone_number, status")
        .eq("account_id", accountId)
        .order("created_at"),
      supabase
        .from("whatsapp_calling_configs")
        .select(
          "connection_id, bridge_url, bridge_secret, bridge_enabled, calling_status, checked_at",
        )
        .eq("account_id", accountId),
    ]);
    const porConexion = new Map(
      ((configs ?? []) as Fila[]).map((c) => [c.connection_id, c]),
    );
    return NextResponse.json({
      connections: (conexiones ?? []).map((c) => {
        const cfg = porConexion.get(c.id as string);
        return {
          ...c,
          bridge_url: cfg?.bridge_url ?? "",
          bridge_enabled: cfg?.bridge_enabled ?? false,
          has_bridge_secret: Boolean(cfg?.bridge_secret),
          calling_status: cfg?.calling_status ?? null,
          checked_at: cfg?.checked_at ?? null,
        };
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const body = (await request.json().catch(() => ({}))) as {
      connectionId?: string;
      bridge_url?: string;
      bridge_secret?: string;
      bridge_enabled?: boolean;
    };
    if (!body.connectionId) {
      return NextResponse.json({ error: "missing_connection" }, { status: 400 });
    }
    const { data: conexion } = await supabase
      .from("whatsapp_connections")
      .select("id")
      .eq("id", body.connectionId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!conexion) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const patch: Record<string, unknown> = {
      connection_id: body.connectionId,
      account_id: accountId,
      bridge_url: body.bridge_url?.trim() || null,
      bridge_enabled: body.bridge_enabled === true,
      updated_at: new Date().toISOString(),
    };
    if (typeof body.bridge_secret === "string" && body.bridge_secret.trim()) {
      patch.bridge_secret = encrypt(body.bridge_secret.trim());
    }
    const { error } = await supabase
      .from("whatsapp_calling_configs")
      .upsert(patch, { onConflict: "connection_id" });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
