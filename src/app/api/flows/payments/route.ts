import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pagos pendientes para el panel de respaldo manual (SPEI incluido). */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("flow_payment_sessions")
      .select(
        "id, provider, reference, amount, currency, status, checkout_url, created_at, expires_at, contact_id, conversation_id, contact:contacts(name, phone, email)",
      )
      .eq("account_id", accountId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return NextResponse.json({ sessions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
