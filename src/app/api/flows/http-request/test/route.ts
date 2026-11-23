import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { ejecutarHttpRequest } from "@/lib/flows/http-request";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { HttpRequestNodeConfig } from "@/lib/flows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * «Probar petición» del bloque Integración HTTP.
 *
 * El navegador no puede saltarse CORS ni el guard SSRF, así que la
 * prueba se ejecuta en el servidor con la misma ruta que el motor.
 * No manda variables reales de una corrida: las fichas de contacto/
 * variables quedan vacías, que es lo esperado en el editor.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    const body = (await request.json().catch(() => ({}))) as {
      config?: HttpRequestNodeConfig;
    };
    const cfg = body.config;
    if (!cfg || typeof cfg !== "object") {
      return NextResponse.json({ error: "missing_config" }, { status: 400 });
    }
    if (!cfg.url || !/^https?:\/\//i.test(cfg.url.trim())) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    if (!["GET", "POST", "PUT", "DELETE"].includes(cfg.method)) {
      return NextResponse.json({ error: "invalid_method" }, { status: 400 });
    }

    const db = supabaseAdmin();
    const resultado = await ejecutarHttpRequest(db, {
      accountId,
      contactId: "",
      vars: {},
      cfg,
    });

    return NextResponse.json({
      status: resultado.status,
      ok: resultado.ok,
      duration_ms: resultado.duration_ms,
      preview: resultado.preview.slice(0, 16 * 1024),
      headers: resultado.headers,
      mapped: resultado.mapped,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
