import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeTables } from '@/lib/flows/fake-db.test-helper';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const { createFakeDb } = await import('@/lib/flows/fake-db.test-helper');
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

import { authenticateMcp, tieneScope } from './auth';
import { generateMcpToken } from './tokens';

let token: ReturnType<typeof generateMcpToken>;

beforeEach(() => {
  token = generateMcpToken();
  h.tables = {
    mcp_credentials: [
      {
        id: 'c1',
        name: 'Claude Desktop',
        account_id: 'a1',
        scopes: ['read', 'send_messages'],
        key_hash: token.hash,
        revoked_at: null,
        last_used_at: null,
      },
    ],
  };
});

function request(bearer: string) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe('authenticateMcp', () => {
  it('resuelve la cuenta y los scopes del token', async () => {
    const r = await authenticateMcp(request(token.plaintext));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx.accountId).toBe('a1');
      expect(r.ctx.credentialName).toBe('Claude Desktop');
      expect(tieneScope(r.ctx, 'read')).toBe(true);
      expect(tieneScope(r.ctx, 'write_flows')).toBe(false);
    }
  });

  it('rechaza tokens inválidos o revocados', async () => {
    const invalido = await authenticateMcp(request('mcp_live_noexiste'));
    expect(invalido.ok).toBe(false);
    if (!invalido.ok) expect(invalido.response.status).toBe(401);

    h.tables.mcp_credentials[0].revoked_at = new Date().toISOString();
    const revocado = await authenticateMcp(request(token.plaintext));
    expect(revocado.ok).toBe(false);
    if (!revocado.ok) expect(revocado.response.status).toBe(401);
  });

  it('rechaza una petición sin cabecera', async () => {
    const r = await authenticateMcp(
      new Request('http://localhost/api/mcp', { method: 'POST' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
});
