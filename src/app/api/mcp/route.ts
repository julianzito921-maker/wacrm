import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateMcp } from '@/lib/mcp/auth';
import { createMcpServer } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP remoto sobre Streamable HTTP.
 *
 * - Auth propia por Bearer (`mcp_live_…`), sin sesión de Supabase.
 * - Modo sin estado: un servidor por request, respuesta JSON.
 * - Claude Desktop/Code se conectan con la cabecera Authorization;
 *   Claude.ai requiere su flujo de conector (OAuth en una fase
 *   posterior si su UI no acepta Bearer).
 */
export async function POST(request: Request) {
  const auth = await authenticateMcp(request);
  if (!auth.ok) return auth.response;

  try {
    const server = createMcpServer(auth.ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    return new Response(
      JSON.stringify({ error: 'internal_error' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}

export async function GET() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST, OPTIONS' },
  });
}

export async function DELETE() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST, OPTIONS' },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: 'POST, OPTIONS' },
  });
}
