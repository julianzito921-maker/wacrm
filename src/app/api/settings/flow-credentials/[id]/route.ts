import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { id } = await ctx.params;
    const { error } = await supabase
      .from("flow_credentials")
      .delete()
      .eq("id", id)
      .eq("account_id", accountId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
