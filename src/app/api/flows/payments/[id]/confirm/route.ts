import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { registrarVentaDeSesionAprobada, resumePaymentGateway } from "@/lib/flows/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirmación manual de un pago (respaldo de SPEI y de cualquier
 * webhook que no llegue). Solo admin de la cuenta.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole("admin");
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      status?: "approved" | "rejected";
    };
    const status = body.status === "rejected" ? "rejected" : "approved";

    const db = supabaseAdmin();
    const { data: session } = await db
      .from("flow_payment_sessions")
      .select("id, flow_run_id, status")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (!session) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if ((session as { status: string }).status !== "pending") {
      return NextResponse.json({ error: "already_closed" }, { status: 409 });
    }

    // Atómico: solo cierra la sesión si sigue en `pending`. Si un webhook
    // o el timeout ganaron entre la lectura y el update, no se toca nada.
    const { data: cerradas, error: updErr } = await db
      .from("flow_payment_sessions")
      .update({
        status,
        approved_at: status === "approved" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("account_id", accountId)
      .eq("status", "pending")
      .select("id");
    if (updErr) throw new Error(updErr.message);
    if (!cerradas || cerradas.length === 0) {
      return NextResponse.json({ error: "already_closed" }, { status: 409 });
    }

    const { data: run } = await db
      .from("flow_runs")
      .select("vars")
      .eq("id", (session as { flow_run_id: string }).flow_run_id)
      .maybeSingle();
    const vars = {
      ...((run as { vars?: Record<string, unknown> } | null)?.vars ?? {}),
      __payment_status: status,
    };
    await db
      .from("flow_runs")
      .update({
        vars,
        next_run_at: new Date().toISOString(),
        resume_reason: "payment_gateway",
      })
      .eq("id", (session as { flow_run_id: string }).flow_run_id)
      .eq("status", "active");

    const reanudada = await resumePaymentGateway(db, {
      runId: (session as { flow_run_id: string }).flow_run_id,
      decision: status,
      sessionId: id,
    });
    if (!reanudada && status === "approved") {
      await registrarVentaDeSesionAprobada(db, id);
    }

    return NextResponse.json({ ok: true, run_resumed: reanudada });
  } catch (err) {
    return toErrorResponse(err);
  }
}
