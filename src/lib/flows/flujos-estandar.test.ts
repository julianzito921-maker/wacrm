import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";
import { candidatosEstandar, cumpleCondicion, normalizarFlujosEstandar } from "./estandar";

/** Flujos estándar por número (como Leona): lógica y motor completo. */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sendText: vi.fn(),
}));

vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(),
  engineSendReaction: vi.fn(),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.b" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.l" })),
  mostrarEscribiendo: vi.fn(),
}));
vi.mock("@/lib/ventas/conversiones", () => ({ enviarEventoMeta: vi.fn(async () => ({ enviado: true })) }));

import { dispatchInboundToFlows, iniciarFlujoAtencionFinalizada } from "./engine";

const ID = {
  bienvenida: "11111111-1111-4111-8111-111111111111",
  reabierta: "22222222-2222-4222-8222-222222222222",
  predeterminada: "33333333-3333-4333-8333-333333333333",
  atencion: "44444444-4444-4444-8444-444444444444",
  promo: "55555555-5555-4555-8555-555555555555",
};

describe("palabras clave y orden (lógica)", () => {
  it("operadores como Leona, sin acentos ni mayúsculas", () => {
    expect(cumpleCondicion("Hola! Info cápsulas", { operator: "contains", value: "capsulas" })).toBe(true);
    expect(cumpleCondicion("precio", { operator: "equals", value: "PRECIO" })).toBe(true);
    expect(cumpleCondicion("hola", { operator: "starts_with", value: "ho" })).toBe(true);
    expect(cumpleCondicion("hola", { operator: "ends_with", value: "la" })).toBe(true);
    expect(cumpleCondicion("hola", { operator: "not_contains", value: "precio" })).toBe(true);
    expect(cumpleCondicion("hola", { operator: "not_equals", value: "hola" })).toBe(false);
  });

  it("orden: palabra clave → bienvenida → reabierta → predeterminada", () => {
    const cfg = normalizarFlujosEstandar({
      welcome_flow_id: ID.bienvenida,
      reopened_flow_id: ID.reabierta,
      default_reply_flow_id: ID.predeterminada,
      keywords: [{ flow_id: ID.promo, conditions: [{ operator: "contains", value: "promo" }] }],
    });
    expect(
      candidatosEstandar(cfg, { textos: ["quiero la promo"], primerMensaje: true, reabierta: true }).map((c) => c.motivo),
    ).toEqual(["keyword", "welcome", "reopened", "default_reply"]);
    expect(candidatosEstandar(cfg, { textos: ["hola"], primerMensaje: false, reabierta: false })[0].motivo).toBe(
      "default_reply",
    );
  });

  it("descarta basura y aplica 24 h por defecto", () => {
    expect(normalizarFlujosEstandar({ welcome_flow_id: "x", keywords: [{ flow_id: ID.promo, conditions: [] }] })).toMatchObject({
      welcome_flow_id: null,
      keywords: [],
      default_reply_hours: 24,
    });
  });
});

function flujo(id: string, texto: string) {
  h.tables.flows.push({
    id,
    account_id: "acct-1",
    user_id: "u-1",
    status: "active",
    entry_node_id: "inicio",
    fallback_policy: { on_timeout_hours: 24 },
    created_at: "2026-01-01T00:00:00Z",
    trigger_type: "manual",
    trigger_config: {},
  });
  h.tables.flow_nodes.push(
    { flow_id: id, node_key: "inicio", node_type: "start", config: { next_node_key: "msg" } },
    { flow_id: id, node_key: "msg", node_type: "send_message", config: { text: texto, next_node_key: "" } },
  );
}

const entrar = (texto: string, opts: { primero?: boolean; reabierta?: boolean } = {}) =>
  dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    connectionId: "conn-1",
    message: { kind: "text", text: texto, meta_message_id: `m-${Math.random()}` },
    isFirstInboundMessage: Boolean(opts.primero),
    isReopenedConversation: Boolean(opts.reabierta),
  });

const enviado = () => (h.sendText.mock.calls.at(-1)?.[0] as { text?: string } | undefined)?.text;

describe("motor con flujos estándar del número", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sendText.mockResolvedValue({ whatsapp_message_id: "wamid.t" });
    h.tables = {
      flows: [],
      flow_nodes: [],
      flow_runs: [],
      flow_run_events: [],
      contacts: [{ id: "ct-1", account_id: "acct-1", name: "Ana", phone: "521555" }],
      messages: [],
      whatsapp_connections: [
        {
          id: "conn-1",
          account_id: "acct-1",
          standard_flows: {
            welcome_flow_id: ID.bienvenida,
            reopened_flow_id: ID.reabierta,
            default_reply_flow_id: ID.predeterminada,
            default_reply_hours: 24,
            attendance_finished_flow_id: ID.atencion,
            keywords: [{ flow_id: ID.promo, conditions: [{ operator: "contains", value: "promo" }] }],
          },
        },
      ],
    };
    flujo(ID.bienvenida, "bienvenida");
    flujo(ID.reabierta, "de vuelta");
    flujo(ID.predeterminada, "predeterminada");
    flujo(ID.atencion, "gracias por tu compra");
    flujo(ID.promo, "promo");
  });

  it("contacto nuevo → Bienvenida", async () => {
    const r = await entrar("hola", { primero: true });
    expect(r.consumed).toBe(true);
    expect(enviado()).toBe("bienvenida");
  });

  it("la palabra clave gana aunque sea el primer mensaje", async () => {
    await entrar("quiero la PROMO", { primero: true });
    expect(enviado()).toBe("promo");
  });

  it("conversación reabierta → Conversación finalizada", async () => {
    await entrar("hola otra vez", { reabierta: true });
    expect(enviado()).toBe("de vuelta");
  });

  it("predeterminada una sola vez dentro de las 24 h", async () => {
    await entrar("hola");
    expect(enviado()).toBe("predeterminada");
    // La base real pone `started_at` sola (DEFAULT now()); la falsa no.
    for (const r of h.tables.flow_runs) r.started_at ??= new Date().toISOString();
    h.sendText.mockClear();
    const r = await entrar("sigo aquí");
    expect(r.consumed).toBe(false);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("Atención finalizada arranca su flujo", async () => {
    const r = await iniciarFlujoAtencionFinalizada({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      connectionId: "conn-1",
    });
    expect(r.iniciado).toBe(true);
    expect(enviado()).toBe("gracias por tu compra");
  });
});
