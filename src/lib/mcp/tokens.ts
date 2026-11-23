// Token generation + hashing for the MCP server. Mirrors the API-key
// rationale in `src/lib/api-keys/keys.ts`: the secret is 256 bits of
// CSPRNG, so a fast SHA-256 with a unique index is the right choice.

import { createHash, randomBytes } from 'node:crypto';

export const MCP_KEY_PREFIX = 'mcp_live_';

export const MCP_SCOPES = [
  'read',
  'write_flows',
  'write_crm',
  'send_messages',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** Non-secret display part: prefix + 8 characters. */
const DISPLAY_BODY_CHARS = 8;

export interface GeneratedMcpToken {
  /** Plaintext, shown once. Never persisted. */
  plaintext: string;
  /** SHA-256 hex, stored in `mcp_credentials.key_hash`. */
  hash: string;
  /** Non-secret display value stored in `key_prefix`. */
  prefix: string;
}

export function generateMcpToken(): GeneratedMcpToken {
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${MCP_KEY_PREFIX}${body}`;
  return {
    plaintext,
    hash: hashMcpToken(plaintext),
    prefix: `${MCP_KEY_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
  };
}

export function hashMcpToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function looksLikeMcpToken(value: string): boolean {
  return (
    value.startsWith(MCP_KEY_PREFIX) && value.length > MCP_KEY_PREFIX.length
  );
}

export function isMcpScope(value: unknown): value is McpScope {
  return (
    typeof value === 'string' && (MCP_SCOPES as readonly string[]).includes(value)
  );
}

/** Validates + dedupes. Returns null when any entry is unknown. */
export function normalizeMcpScopes(input: unknown): McpScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: McpScope[] = [];
  for (const entry of input) {
    if (!isMcpScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.length > 0 ? out : null;
}
