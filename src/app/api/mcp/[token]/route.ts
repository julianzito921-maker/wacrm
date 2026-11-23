import { POST as postMcp, GET, DELETE, OPTIONS } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Variante del endpoint MCP con el token en la ruta: /api/mcp/<token>
 *
 * Los conectores personalizados de Claude.ai no permiten enviar una
 * cabecera Authorization fija, así que el token viaja en la URL y aquí
 * se convierte en `Authorization: Bearer …` antes de reutilizar el
 * handler normal. La validación (hash, revocación, scopes, rate limit)
 * es exactamente la misma que en /api/mcp.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const headers = new Headers(request.headers);
  if (!headers.get('authorization')) {
    headers.set('authorization', `Bearer ${decodeURIComponent(token)}`);
  }
  const body = await request.arrayBuffer();
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body,
  });
  return postMcp(forwarded);
}

export { GET, DELETE, OPTIONS };
