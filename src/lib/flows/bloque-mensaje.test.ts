import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

/**
 * Bloque Mensaje compuesto (burbujas en orden, «escribiendo…» por
 * burbuja, 👍 opcional, intervalos), fin de rama automático y el
 * disparador «Cualquier mensaje» (una vez por contacto cada 24 h).
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  orden: [] as string[],
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  reaccion: vi.fn(),
  escribiendo: vi.fn(),
}));

vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: h.sendMedia,
  engineSendReaction: h.reaccion,
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.b" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.l" })),
  mostrarEscribiendo: h.escribiendo,
}));

vi.mock("@/lib/ventas/conversiones", () => ({
  enviarEventoMeta: vi.fn(async () => ({ enviado: true })),
}));

import { supabaseAdmin } from "./admin-client";
import { dispatchInboundToFlows, resumeDueRuns } from "./engine";
import type { ParsedInbound } from "./types";
import { validateFlowForActivation } from "./validate";

const HOUR = 3_600_000;

function flujo(
  nodos: Record<string, unknown>[],
  trigger: Record<string, unknown> = {
    trigger_type: "keyword",
    trigger_config: { keywords: ["chia"], match_type: "contains" },
  },
  id = "flow-1",
  created_at = "2026-01-01T00:00:00Z",
) {
  h.tables.flows.push({
    id,
    account_id: "acct-1",
    user_id: "u-1",
    status: "active",
    entry_node_id: "inicio",
    fallback_policy: { on_timeout_hours: 1 },
    created_at,
    ...trigger,
  });
  h.tables.flow_nodes.push(...nodos.map((n) => ({ flow_id: id, ...n })));
}

const texto = (t: string, id: string): ParsedInbound => ({ kind: "text", text: t, meta_message_id: id });

function dispatch(message: ParsedInbound, isFirstInboundMessage = false) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage,
  });
}

const corrida = () => h.tables.flow_runs[0] as Record<string, unknown>;

const MENSAJE = (items: Record<string, unknown>[], next = "") => [
  { node_key: "inicio", node_type: "start", config: { next_node_key: "msj" } },
  { node_key: "msj", node_type: "send_message", config: { text: "", items, next_node_key: next } },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.orden = [];
  h.sendText.mockImplementation(async (a: { text: string }) => {
    h.orden.push(`texto:${a.text}`);
    return { whatsapp_message_id: "wamid.text" };
  });
  h.sendMedia.mockImplementation(async (a: { kind: string }) => {
    h.orden.push(`medio:${a.kind}`);
    return { whatsapp_message_id: "wamid.media" };
  });
  h.reaccion.mockImplementation(async (a: { emoji: string }) => {
    h.orden.push(`reaccion:${a.emoji}`);
  });
  h.escribiendo.mockImplementation(async () => {
    h.orden.push("escribiendo");
  });
  h.tables = {
    flows: [],
    flow_nodes: [],
    flow_runs: [],
    flow_run_events: [],
    messages: [
      {
        conversation_id: "cv-1",
        sender_type: "customer",
        message_id: "wamid.in",
        created_at: new Date().toISOString(),
      },
    ],
  };
});

describe("Mensaje compuesto", () => {
  it("manda las burbujas en orden, con 👍 y «escribiendo…», y cierra al final de la rama", async () => {
    flujo(
      MENSAJE([
        { tipo: "text", text: "Hola 🌱", segundos: 3, like: true },
        { tipo: "image", media_url: "https://x/foto.jpg", text: "Mira", segundos: 0 },
        { tipo: "interval", segundos: 2 },
        { tipo: "sticker", media_url: "https://x/s.webp", segundos: 1 },
      ]),
    );
    const r = await dispatch(texto("quiero chia", "m1"));

    expect(r).toMatchObject({ consumed: true, outcome: "completed" });
    expect(h.orden).toEqual([
      "reaccion:👍",
      "escribiendo",
      "texto:Hola 🌱",
      "medio:image",
      "escribiendo",
      "medio:sticker",
    ]);
    // El sticker no lleva pie de foto; la imagen sí.
    expect(h.sendMedia.mock.calls[0][0]).toMatchObject({ kind: "image", caption: "Mira" });
    expect(h.sendMedia.mock.calls[1][0].caption).toBeUndefined();
    // Sin conexión saliente: fin de rama limpio, no error.
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "fin_de_rama" });
  });

  it("sin `items` se comporta como el mensaje de siempre", async () => {
    flujo([
      { node_key: "inicio", node_type: "start", config: { next_node_key: "msj" } },
      { node_key: "msj", node_type: "send_message", config: { text: "Hola", next_node_key: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    await dispatch(texto("chia", "m1"));
    expect(h.orden.filter((x) => x.startsWith("texto"))).toEqual(["texto:Hola"]);
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "end_node" });
  });

  it("«escribiendo…» de más de 15 s estaciona la corrida y el cron sigue en esa burbuja", async () => {
    flujo(
      [
        ...MENSAJE(
          [
            { tipo: "text", text: "Uno", segundos: 0 },
            { tipo: "text", text: "Dos", segundos: 40, like: true },
            { tipo: "text", text: "Tres", segundos: 0 },
          ],
          "fin",
        ),
        { node_key: "fin", node_type: "end", config: {} },
      ],
    );
    const antes = Date.now();
    const r = await dispatch(texto("chia", "m1"));

    expect(r).toMatchObject({ consumed: true, outcome: "started" });
    expect(h.orden).toEqual(["texto:Uno", "reaccion:👍", "escribiendo"]);
    expect(corrida()).toMatchObject({
      status: "active",
      current_node_key: "msj",
      resume_reason: "delay",
      vars: { __burbuja: { nodo: "msj", i: 1 } },
    });
    const vence = new Date(corrida().next_run_at as string).getTime();
    expect(vence - antes).toBeGreaterThanOrEqual(40_000 - 1000);

    // La clienta escribe mientras tanto: el flujo sigue siendo dueño.
    const r2 = await dispatch(texto("¿hola?", "m2"));
    expect(r2).toMatchObject({ consumed: true, outcome: "waiting" });

    // Antes de tiempo el cron no hace nada.
    expect(await resumeDueRuns(supabaseAdmin(), new Date(antes + 10_000))).toBe(0);

    // Al vencer: manda «Dos» sin repetir 👍 ni la espera, luego «Tres».
    expect(await resumeDueRuns(supabaseAdmin(), new Date(antes + 60_000))).toBe(1);
    expect(h.orden).toEqual(["texto:Uno", "reaccion:👍", "escribiendo", "texto:Dos", "texto:Tres"]);
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "end_node" });
    expect((corrida().vars as Record<string, unknown>).__burbuja).toBeUndefined();
  });

  it("un intervalo largo también se estaciona y no se repite al retomar", async () => {
    flujo(
      MENSAJE([
        { tipo: "text", text: "Antes", segundos: 0 },
        { tipo: "interval", segundos: 2 * 3600 },
        { tipo: "audio", media_url: "https://x/voz.ogg", segundos: 0 },
      ]),
    );
    const antes = Date.now();
    await dispatch(texto("chia", "m1"));
    expect(h.orden).toEqual(["texto:Antes"]);
    expect(corrida()).toMatchObject({ vars: { __burbuja: { nodo: "msj", i: 1 } } });

    expect(await resumeDueRuns(supabaseAdmin(), new Date(antes + 2 * HOUR + 60_000))).toBe(1);
    expect(h.orden).toEqual(["texto:Antes", "medio:audio"]);
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "fin_de_rama" });
  });

  it("si falla una burbuja, la corrida falla con el número de burbuja", async () => {
    h.sendMedia.mockRejectedValueOnce(new Error("Meta 400"));
    flujo(
      MENSAJE([
        { tipo: "text", text: "Hola", segundos: 0 },
        { tipo: "video", media_url: "https://x/v.mp4", segundos: 0 },
        { tipo: "text", text: "Nunca", segundos: 0 },
      ]),
    );
    await dispatch(texto("chia", "m1"));
    expect(h.orden).toEqual(["texto:Hola"]);
    expect(corrida()).toMatchObject({ status: "failed", end_reason: "send_bubble_failed" });
    const evento = h.tables.flow_run_events.find(
      (e) => (e.payload as Record<string, unknown> | undefined)?.reason === "send_bubble_failed",
    );
    expect(evento?.payload).toMatchObject({ burbuja: 1, tipo: "video" });
  });
});

describe("Fin de rama automático", () => {
  it("Kanban, Etiqueta o Espera sin conexión cierran como completado", async () => {
    flujo([
      { node_key: "inicio", node_type: "start", config: { next_node_key: "espera" } },
      { node_key: "espera", node_type: "wait", config: { segundos: 1, next_node_key: "" } },
    ]);
    await dispatch(texto("chia", "m1"));
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "fin_de_rama" });
  });

  it("un Inicio sin conexión sigue siendo error (no es un nodo de una salida «final»)", async () => {
    flujo([
      { node_key: "inicio", node_type: "start", config: { next_node_key: "" } },
    ]);
    await dispatch(texto("chia", "m1"));
    expect(corrida()).toMatchObject({ status: "failed", end_reason: "missing_next_node" });
  });

  it("el validador ya no marca error en Mensaje sin conexión, pero sí en Inicio", () => {
    const issues = validateFlowForActivation(
      { name: "x", trigger_type: "keyword", trigger_config: { keywords: ["a"] }, entry_node_id: "inicio" },
      [
        { node_key: "inicio", node_type: "start", config: { next_node_key: "msj" } },
        {
          node_key: "msj",
          node_type: "send_message",
          config: { text: "", items: [{ tipo: "text", text: "Hola", segundos: 3 }], next_node_key: "" },
        },
      ],
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);

    const sinInicio = validateFlowForActivation(
      { name: "x", trigger_type: "keyword", trigger_config: { keywords: ["a"] }, entry_node_id: "inicio" },
      [{ node_key: "inicio", node_type: "start", config: { next_node_key: "" } }],
    );
    expect(sinInicio.some((i) => i.severity === "error" && i.node_key === "inicio")).toBe(true);
  });

  it("el validador marca burbujas vacías y fuera de rango", () => {
    const issues = validateFlowForActivation(
      { name: "x", trigger_type: "keyword", trigger_config: { keywords: ["a"] }, entry_node_id: "inicio" },
      [
        { node_key: "inicio", node_type: "start", config: { next_node_key: "msj" } },
        {
          node_key: "msj",
          node_type: "send_message",
          config: {
            text: "",
            items: [
              { tipo: "text", text: " ", segundos: 3 },
              { tipo: "image", media_url: "", segundos: 3 },
              { tipo: "text", text: "ok", segundos: 90 },
              { tipo: "interval", segundos: 0 },
            ],
            next_node_key: "",
          },
        },
      ],
    );
    const campos = issues.filter((i) => i.severity === "error").map((i) => i.field);
    expect(campos).toEqual(["items.0.text", "items.1.media_url", "items.2.segundos", "items.3.segundos"]);
  });
});

describe("Disparador «Cualquier mensaje»", () => {
  const SIMPLE = (id: string, txt: string) => [
    { node_key: "inicio", node_type: "start", config: { next_node_key: "msj" } },
    { node_key: "msj", node_type: "send_message", config: { text: txt, next_node_key: "" } },
  ].map((n) => ({ ...n, flow_id: id }));

  it("arranca con cualquier texto y no se repite en 24 h (el chat queda para la IA)", async () => {
    flujo(SIMPLE("flow-1", "Bienvenida"), { trigger_type: "any_message", trigger_config: {} });

    const r1 = await dispatch(texto("hola", "m1"));
    expect(r1).toMatchObject({ consumed: true, outcome: "completed" });
    corrida().started_at = new Date().toISOString();

    const r2 = await dispatch(texto("otra cosa", "m2"));
    expect(r2).toMatchObject({ consumed: false, outcome: "no_match" });
    expect(h.sendText).toHaveBeenCalledTimes(1);

    // Pasadas 24 h vuelve a poder dispararse.
    corrida().started_at = new Date(Date.now() - 25 * HOUR).toISOString();
    const r3 = await dispatch(texto("hola de nuevo", "m3"));
    expect(r3).toMatchObject({ consumed: true, outcome: "completed" });
  });

  it("prioridad: palabra clave → primer mensaje → cualquier mensaje", async () => {
    // El de «cualquier mensaje» es el más antiguo, pero va al final.
    flujo(SIMPLE("f-any", "Cualquiera"), { trigger_type: "any_message", trigger_config: {} }, "f-any", "2025-01-01T00:00:00Z");
    flujo(SIMPLE("f-first", "Primero"), { trigger_type: "first_inbound_message", trigger_config: {} }, "f-first", "2025-06-01T00:00:00Z");
    flujo(
      SIMPLE("f-kw", "Clave"),
      { trigger_type: "keyword", trigger_config: { keywords: ["chia"], match_type: "contains" } },
      "f-kw",
      "2026-01-01T00:00:00Z",
    );

    await dispatch(texto("quiero chia", "m1"), true);
    expect(h.orden).toContain("texto:Clave");

    h.tables.flow_runs = [];
    h.orden = [];
    await dispatch(texto("hola", "m2"), true);
    expect(h.orden).toContain("texto:Primero");

    h.tables.flow_runs = [];
    h.orden = [];
    await dispatch(texto("hola", "m3"), false);
    expect(h.orden).toContain("texto:Cualquiera");
  });
});
