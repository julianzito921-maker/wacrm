import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("flow_credentials")
      .select("id, name, created_at")
      .eq("account_id", accountId)
      .order("name");
    if (error) throw new Error(error.message);
    return NextResponse.json({ credentials: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("admin");
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      value?: string;
    };
    const name = body.name?.trim();
    const value = body.value?.trim();
    if (!name || !value) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("flow_credentials")
      .insert({
        account_id: accountId,
        name,
        value: encrypt(value),
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) {
      return NextResponse.json(
        { error: error.code === "23505" ? "duplicate" : error.message },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, id: (data as { id: string }).id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
