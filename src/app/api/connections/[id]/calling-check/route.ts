import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { credencialesDeConexion } from "@/lib/whatsapp/connections";
import {
  disponibilidadPorPais,
  estadoDesdeSettings,
  refrescarEstadoLlamadas,
} from "@/lib/flows/official-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verifica la disponibilidad oficial de llamadas de una conexión. */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await ctx.params;
    const { data: conexion } = await supabase
      .from("whatsapp_connections")
      .select(
        "id, account_id, phone_number, display_phone_number, messaging_limit_tier, whatsapp_business_manager_messaging_limit",
      )
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!conexion) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const creds = await credencialesDeConexion(supabase, id);
    if (!creds) {
      return NextResponse.json({ error: "credentials_unavailable" }, { status: 400 });
    }

    const settings = await refrescarEstadoLlamadas(supabase, {
      accountId,
      connectionId: id,
      creds,
    });
    const estado = estadoDesdeSettings(settings);
    const pais = disponibilidadPorPais(
      (conexion as { display_phone_number?: string | null }).display_phone_number ??
        (conexion as { phone_number?: string | null }).phone_number ??
        null,
      (conexion as { whatsapp_business_manager_messaging_limit?: string | null })
        .whatsapp_business_manager_messaging_limit ??
        (conexion as { messaging_limit_tier?: string | null }).messaging_limit_tier ??
        null,
    );

    return NextResponse.json({
      settings: settings.calling ?? {},
      available: estado.supported && pais.supported,
      country: pais.country,
      country_supported: pais.supported,
      calling_enabled: estado.supported,
      reason: !pais.supported ? pais.reason : estado.reason,
      detail: pais.detail ?? estado.detail ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
