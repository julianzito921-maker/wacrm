import { afterEach, describe, expect, it, vi } from "vitest";
import { ClienteLeona, LEONA_MCP_URL, LeonaError, separarCodigos } from "./cliente";

const FLUJO = { flow: { name: "X" }, nodes: [{ id: 1, node_type: "start", actions: [] }], connections: [] };

function respuesta(cuerpo: string, tipo = "application/json", extra: Record<string, string> = {}, status = 200) {
  return new Response(cuerpo, { status, headers: { "content-type": tipo, ...extra } });
}

describe("cliente MCP de Leona", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("abre sesión, la reutiliza y lee get_flow en SSE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respuesta(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), "application/json", { "mcp-session-id": "S1" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        respuesta(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(FLUJO) }] } })}\n\n`,
          "text/event-stream",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const flujo = await new ClienteLeona("tok").obtenerFlujo("123");
    expect(flujo).toEqual(FLUJO);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(LEONA_MCP_URL);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Mcp-Session-Id"]).toBe("S1");
    expect(JSON.parse(init.body)).toMatchObject({ method: "tools/call", params: { name: "get_flow", arguments: { flow_id: "123" } } });
  });

  it("credencial inválida → error claro (400)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respuesta("{}", "application/json", {}, 401)));
    await expect(new ClienteLeona("malo").obtenerFlujo("1")).rejects.toMatchObject({
      name: "LeonaError",
      httpStatus: 400,
    });
  });

  it("flujo que no existe → 404 con el mensaje de Leona", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(respuesta(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(
          respuesta(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "Flow not found" }] } })),
        ),
    );
    const err = await new ClienteLeona("tok").obtenerFlujo("999").catch((e) => e);
    expect(err).toBeInstanceOf(LeonaError);
    expect(err).toMatchObject({ httpStatus: 404, message: "Flow not found" });
  });

  it("separa códigos como el importador de Leona", () => {
    expect(
      separarCodigos("123, 456\n264fbb69-0a4f-4e28-8cd7-4e706f17448f ; 123 basura"),
    ).toEqual(["123", "456", "264fbb69-0a4f-4e28-8cd7-4e706f17448f"]);
  });
});
