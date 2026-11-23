import { describe, expect, it } from 'vitest';
import {
  MCP_KEY_PREFIX,
  generateMcpToken,
  hashMcpToken,
  looksLikeMcpToken,
  normalizeMcpScopes,
} from './tokens';

describe('tokens MCP', () => {
  it('genera un token con prefijo, hash y prefijo visible', () => {
    const t = generateMcpToken();
    expect(t.plaintext.startsWith(MCP_KEY_PREFIX)).toBe(true);
    expect(t.hash).toBe(hashMcpToken(t.plaintext));
    expect(t.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(t.prefix.startsWith(MCP_KEY_PREFIX)).toBe(true);
    expect(t.plaintext.startsWith(t.prefix)).toBe(true);
    expect(t.prefix.length).toBe(MCP_KEY_PREFIX.length + 8);
  });

  it('reconoce el formato y valida scopes', () => {
    expect(looksLikeMcpToken('mcp_live_abc')).toBe(true);
    expect(looksLikeMcpToken('wacrm_live_abc')).toBe(false);
    expect(normalizeMcpScopes(['read', 'read', 'write_crm'])).toEqual([
      'read',
      'write_crm',
    ]);
    expect(normalizeMcpScopes(['read', 'admin'])).toBeNull();
    expect(normalizeMcpScopes([])).toBeNull();
  });
});
