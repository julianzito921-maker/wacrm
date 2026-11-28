/**
 * Cliente mínimo del servidor MCP de Leona (solo lectura), para importar
 * flujos: `get_flow` (el flujo completo por id o código/uuid) y
 * `list_flows` (para elegirlos de una lista).
 *
 * Servidor: https://apiaws.leonasolutions.io/mcp (Streamable HTTP,
 * JSON-RPC). Autorización: la credencial estática que se crea en Leona →
 * Configuración → Herramientas MCP («Cursor y n8n: token estático +
 * Bearer»), guardada cifrada en Configuración → Integraciones → Leona.
 *
 * Solo resuelve flujos de la cuenta de esa credencial: un código
 * compartido desde OTRA cuenta de Leona hay que importarlo primero en la
 * Leona propia (Flujos → Importar) y después traerlo aquí.
 */

export const LEONA_MCP_URL = 'https://apiaws.leonasolutions.io/mcp';

export class LeonaError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 502) {
    super(message);
    this.name = 'LeonaError';
    this.httpStatus = httpStatus;
  }
}

/** Lee la respuesta JSON-RPC, venga como JSON o como SSE («data: …»). */
async function leerRespuesta(res: Response, id: number): Promise<Record<string, unknown>> {
  const texto = await res.text();
  const candidatos: string[] = [];
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const linea of texto.split(/\r?\n/)) {
      if (linea.startsWith('data:')) candidatos.push(linea.slice(5).trim());
    }
  } else {
    candidatos.push(texto);
  }
  for (const c of candidatos) {
    try {
      const json = JSON.parse(c) as Record<string, unknown>;
      if (json.id === id || json.result || json.error) return json;
    } catch {
      // línea que no es JSON: se ignora
    }
  }
  throw new LeonaError('Leona respondió algo que no se pudo leer.');
}

export class ClienteLeona {
  private sesion: string | null = null;
  private siguienteId = 1;

  constructor(
    private readonly token: string,
    private readonly url: string = LEONA_MCP_URL,
  ) {}

  private async enviar(
    metodo: string,
    params?: Record<string, unknown>,
    notificacion = false,
  ): Promise<Record<string, unknown>> {
    const id = this.siguienteId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sesion ? { 'Mcp-Session-Id': this.sesion } : {}),
      },
      body: JSON.stringify(
        notificacion
          ? { jsonrpc: '2.0', method: metodo, ...(params ? { params } : {}) }
          : { jsonrpc: '2.0', id, method: metodo, ...(params ? { params } : {}) },
      ),
      signal: AbortSignal.timeout(30_000),
    });
    const sesion = res.headers.get('mcp-session-id');
    if (sesion) this.sesion = sesion;
    if (res.status === 401 || res.status === 403) {
      throw new LeonaError('La credencial de Leona no es válida o venció.', 400);
    }
    if (!res.ok && !(notificacion && res.status === 202)) {
      throw new LeonaError(`Leona respondió ${res.status}.`);
    }
    if (notificacion) return {};
    return leerRespuesta(res, id);
  }

  private async iniciar() {
    if (this.sesion !== null) return;
    await this.enviar('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wacrm-importador', version: '1.0.0' },
    });
    this.sesion = this.sesion ?? '';
    await this.enviar('notifications/initialized', undefined, true);
  }

  /** Llama una herramienta y devuelve su contenido JSON. */
  async herramienta<T = unknown>(nombre: string, args: Record<string, unknown>): Promise<T> {
    await this.iniciar();
    const r = await this.enviar('tools/call', { name: nombre, arguments: args });
    if (r.error) {
      const e = r.error as { message?: string };
      throw new LeonaError(e.message || 'Leona devolvió un error.');
    }
    const res = (r.result ?? {}) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
    };
    const texto = res.content?.find((c) => c.type === 'text')?.text ?? '';
    if (res.isError) throw new LeonaError(texto || 'Leona no encontró ese flujo.', 404);
    if (res.structuredContent) return res.structuredContent as T;
    try {
      return JSON.parse(texto) as T;
    } catch {
      throw new LeonaError(texto || 'Leona devolvió una respuesta vacía.', 404);
    }
  }

  obtenerFlujo(codigo: string) {
    return this.herramienta<Record<string, unknown>>('get_flow', { flow_id: codigo });
  }

  listarFlujos(limite = 100) {
    return this.herramienta<unknown>('list_flows', { limit: limite });
  }
}

/** «123, abc-…\n456» → ['123', 'abc-…', '456'] (como el importador de Leona). */
export function separarCodigos(texto: string): string[] {
  return [
    ...new Set(
      texto
        .split(/[\s,;]+/)
        .map((c) => c.trim())
        .filter((c) => /^(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(c)),
    ),
  ];
}
