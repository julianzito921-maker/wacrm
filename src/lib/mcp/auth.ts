import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  hashMcpToken,
  looksLikeMcpToken,
  type McpScope,
} from './tokens';

export interface McpAuthContext {
  credentialId: string;
  credentialName: string;
  accountId: string;
  scopes: McpScope[];
}

export type McpAuthResult =
  | { ok: true; ctx: McpAuthContext }
  | { ok: false; response: Response };

const LAST_USED_THROTTLE_MS = 60_000;

function fail(status: number, error: string): McpAuthResult {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (status === 401) headers['www-authenticate'] = 'Bearer';
  return {
    ok: false,
    response: new Response(JSON.stringify({ error }), { status, headers }),
  };
}

/**
 * Resuelve el Bearer de un conector MCP a una credencial activa. No usa
 * la sesión de Supabase: los conectores viven fuera del navegador.
 */
export async function authenticateMcp(
  request: Request,
): Promise<McpAuthResult> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !looksLikeMcpToken(match[1].trim())) {
    return fail(401, 'unauthorized');
  }

  const hash = hashMcpToken(match[1].trim());
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('mcp_credentials')
    .select('id, name, account_id, scopes, revoked_at, last_used_at')
    .eq('key_hash', hash)
    .maybeSingle();

  if (error) {
    console.error('[mcp] auth lookup failed:', error.message);
    return fail(500, 'auth_error');
  }
  if (!data || data.revoked_at) return fail(401, 'unauthorized');

  const limite = checkRateLimit(`mcp:${data.id}`, {
    limit: 240,
    windowMs: 60_000,
  });
  if (!limite.success) return fail(429, 'rate_limited');

  // Throttle the write: one per minute is plenty for "last used".
  const ultimo = data.last_used_at
    ? new Date(data.last_used_at as string).getTime()
    : 0;
  if (Date.now() - ultimo > LAST_USED_THROTTLE_MS) {
    void db
      .from('mcp_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id);
  }

  return {
    ok: true,
    ctx: {
      credentialId: data.id as string,
      credentialName: (data.name as string) ?? 'MCP',
      accountId: data.account_id as string,
      scopes: (data.scopes as McpScope[]) ?? [],
    },
  };
}

export function tieneScope(ctx: McpAuthContext, scope: McpScope): boolean {
  return ctx.scopes.includes(scope);
}
