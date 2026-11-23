import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { generateMcpToken, normalizeMcpScopes } from '@/lib/mcp/tokens';

const CAMPOS =
  'id, name, key_prefix, scopes, last_used_at, revoked_at, created_at';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('mcp_credentials')
      .select(CAMPOS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ credentials: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) {
      return NextResponse.json({ error: 'missing_name' }, { status: 400 });
    }
    const scopes = normalizeMcpScopes(body.scopes);
    if (!scopes) {
      return NextResponse.json({ error: 'invalid_scopes' }, { status: 400 });
    }

    const token = generateMcpToken();
    const { data, error } = await ctx.supabase
      .from('mcp_credentials')
      .insert({
        account_id: ctx.accountId,
        name,
        key_prefix: token.prefix,
        key_hash: token.hash,
        scopes,
        created_by: ctx.userId,
      })
      .select(CAMPOS)
      .single();
    if (error) throw new Error(error.message);

    // El texto plano se devuelve una única vez.
    return NextResponse.json(
      { credential: data, token: token.plaintext },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
