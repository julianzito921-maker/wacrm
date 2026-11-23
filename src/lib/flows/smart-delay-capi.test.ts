import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

/**
 * Migración 077: Smart Delay largo (la corrida se estaciona con
 * `next_run_at` y el cron la retoma), «guardar respuesta» con temporizador,
 * nodo Meta CAPI y el corte de la ventana de 24 h.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.text" })),
  evento: vi.fn(async () => ({ enviado: true })),
}));

vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.media" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.b" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.l" })),
  mostrarEscribiendo: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ventas/conversiones", () => ({
  enviarEventoMeta: h.evento,
}));

import { supabaseAdmin } from "./admin-client";
import { closureForActiveRun, dispatchInboundToFlows, resumeDueRuns } from "./engine";
import type { ParsedInbound } from "./types";
import { validateFlowForActivation } from "./validate";

const HOUR = 3_600_000;

function flujo(nodos: Record<string, unknown>[]) {
  h.tables.flows = [
    {
      id: "flow-1",
      account_id: "acct-1",
      user_id: "u-1",
      status: "active",
      trigger_type: "keyword",
      trigger_config: { keywords: ["chia"], match_type: "contains" },
      entry_node_id: "inicio",
      fallback_policy: { on_timeout_hours: 1 },
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  h.tables.flow_nodes = nodos.map((n) => ({ flow_id: "flow-1", ...n }));
}

const CADENA_DELAY = [
  { node_key: "inicio", node_type: "start", config: { next_node_key: "hola" } },
  { node_key: "hola", node_type: "send_message", config: { text: "Hola", next_node_key: "espera" } },
  { node_key: "espera", node_type: "wait", config: { segundos: 2 * 3600, next_node_key: "seguimiento" } },
  { node_key: "seguimiento", node_type: "send_message", config: { text: "¿Pudiste verlo?", next_node_key: "capi" } },
  { node_key: "capi", node_type: "meta_capi", config: { event_name: "Lead", next_node_key: "fin" } },
  { node_key: "fin", node_type: "end", config: {} },
];

const texto = (t: string, id: string): ParsedInbound => ({ kind: "text", text: t, meta_message_id: id });

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

/** Mensaje de la clienta (para la ventana de 24 h). */
function ultimoMensajeDeLaClienta(haceMs: number) {
  h.tables.messages = [
    {
      conversation_id: "cv-1",
      sender_type: "customer",
      message_id: "wamid.in",
      created_at: new Date(Date.now() - haceMs).toISOString(),
    },
  ];
}

const corrida = () => h.tables.flow_runs[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  h.tables = { flows: [], flow_nodes: [], flow_runs: [], flow_run_events: [], messages: [] };
  ultimoMensajeDeLaClienta(0);
});

describe("Smart Delay largo", () => {
  it("se estaciona con next_run_at en vez de esperar dentro del webhook", async () => {
    flujo(CADENA_DELAY);
    const antes = Date.now();
    const r = await dispatch(texto("quiero chia", "m1"));

    expect(r).toMatchObject({ consumed: true, outcome: "started" });
    expect(h.sendText).toHaveBeenCalledTimes(1); // solo «Hola»
    expect(corrida()).toMatchObject({
      status: "active",
      current_node_key: "espera",
      resume_reason: "delay",
    });
    const vence = new Date(corrida().next_run_at as string).getTime();
    expect(vence - antes).toBeGreaterThanOrEqual(2 * HOUR - 1000);
    expect(vence - antes).toBeLessThanOrEqual(2 * HOUR + 5000);
  });

  it("si la clienta escribe durante la espera, el flujo sigue siendo dueño", async () => {
    flujo(CADENA_DELAY);
    await dispatch(texto("quiero chia", "m1"));
    const r = await dispatch(texto("¿y cuánto cuesta?", "m2"));

    expect(r).toMatchObject({ consumed: true, flow_run_id: corrida().id, outcome: "waiting" });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(corrida()).toMatchObject({ current_node_key: "espera", reprompt_count: 0 });
  });

  it("el cron no la retoma antes de tiempo", async () => {
    flujo(CADENA_DELAY);
    await dispatch(texto("quiero chia", "m1"));
    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + HOUR));
    expect(n).toBe(0);
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("al vencer, el cron la retoma: manda el seguimiento, dispara CAPI y termina", async () => {
    flujo(CADENA_DELAY);
    await dispatch(texto("quiero chia", "m1"));
    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + 2 * HOUR + 60_000));

    expect(n).toBe(1);
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(h.sendText.mock.calls[1]).toEqual([expect.objectContaining({ text: "¿Pudiste verlo?" })]);
    expect(h.evento).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        contactId: "ct-1",
        eventName: "Lead",
        eventId: `${corrida().id}-capi`,
      }),
    );
    expect(corrida()).toMatchObject({ status: "completed", next_run_at: null });
  });

  it("dos crons a la vez: solo uno la retoma (no hay mensaje doble)", async () => {
    flujo(CADENA_DELAY);
    await dispatch(texto("quiero chia", "m1"));
    const despues = new Date(Date.now() + 3 * HOUR);
    const [a, b] = await Promise.all([
      resumeDueRuns(supabaseAdmin(), despues),
      resumeDueRuns(supabaseAdmin(), despues),
    ]);
    expect(a + b).toBe(1);
    expect(h.sendText).toHaveBeenCalledTimes(2);
  });

  it("fuera de la ventana de 24 h termina sin mandar nada", async () => {
    flujo(CADENA_DELAY);
    await dispatch(texto("quiero chia", "m1"));
    ultimoMensajeDeLaClienta(24 * HOUR);
    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + 3 * HOUR));

    expect(n).toBe(1);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(corrida()).toMatchObject({ status: "cancelled", end_reason: "fuera_de_ventana_24h" });
  });

  it("una espera de 15 s o menos (el «escribiendo…») se hace en el momento, sin estacionar", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      flujo([
        { node_key: "inicio", node_type: "start", config: { next_node_key: "espera" } },
        { node_key: "espera", node_type: "wait", config: { segundos: 15, next_node_key: "msg" } },
        { node_key: "msg", node_type: "send_message", config: { text: "Listo", next_node_key: "fin" } },
        { node_key: "fin", node_type: "end", config: {} },
      ]);
      const p = dispatch(texto("chia", "m1"));
      await vi.advanceTimersByTimeAsync(15_000);
      await p;
      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(corrida()).toMatchObject({ status: "completed" });
      expect(corrida().next_run_at ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("una espera de 16 s ya no ocupa el webhook: se estaciona para el cron", async () => {
    flujo([
      { node_key: "inicio", node_type: "start", config: { next_node_key: "espera" } },
      { node_key: "espera", node_type: "wait", config: { segundos: 16, next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Listo", next_node_key: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    const inicio = Date.now();
    await dispatch(texto("chia", "m1"));
    // Volvió al instante: no se quedó 16 s esperando dentro del webhook.
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(corrida()).toMatchObject({ current_node_key: "espera", resume_reason: "delay" });

    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + 60_000));
    expect(n).toBe(1);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(corrida()).toMatchObject({ status: "completed" });
  });

  it("una corrida estacionada no se da por abandonada antes de vencer", () => {
    const ahora = new Date();
    const cierre = closureForActiveRun({
      run: {
        current_node_key: "espera",
        last_advanced_at: new Date(ahora.getTime() - 5 * HOUR).toISOString(),
        next_run_at: new Date(ahora.getTime() + HOUR).toISOString(),
      },
      flow: { status: "active", fallback_policy: { on_timeout_hours: 1 } as never },
      nodeKeys: new Set(["espera"]),
      now: ahora,
    });
    expect(cierre).toBeNull();
  });
});

describe("Guardar respuesta con temporizador", () => {
  const NODOS = [
    { node_key: "inicio", node_type: "start", config: { next_node_key: "pregunta" } },
    {
      node_key: "pregunta",
      node_type: "save_reply",
      config: {
        prompt_text: "¿Cuántos años tienes?",
        var_key: "edad",
        espera_minutos: 30,
        contesto_next: "gracias",
        no_contesto_next: "recordar",
      },
    },
    { node_key: "gracias", node_type: "send_message", config: { text: "Gracias", next_node_key: "fin" } },
    { node_key: "recordar", node_type: "send_message", config: { text: "¿Sigues ahí?", next_node_key: "fin" } },
    { node_key: "fin", node_type: "end", config: {} },
  ];

  it("al suspender deja next_run_at; si contesta, se suelta el temporizador", async () => {
    flujo(NODOS);
    await dispatch(texto("chia", "m1"));
    expect(corrida()).toMatchObject({ current_node_key: "pregunta", resume_reason: "reply_timeout" });

    await dispatch(texto("45", "m2"));
    expect(corrida()).toMatchObject({ status: "completed", next_run_at: null, vars: { edad: "45" } });
    expect(h.sendText.mock.calls.map((c) => (c as unknown as [{ text: string }])[0].text)).toEqual([
      "¿Cuántos años tienes?",
      "Gracias",
    ]);
  });

  it("si no contesta, el cron la manda por «no contesta»", async () => {
    flujo(NODOS);
    await dispatch(texto("chia", "m1"));
    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + 31 * 60_000));
    expect(n).toBe(1);
    expect(h.sendText.mock.calls.map((c) => (c as unknown as [{ text: string }])[0].text)).toEqual([
      "¿Cuántos años tienes?",
      "¿Sigues ahí?",
    ]);
  });
});

describe("Nodo Meta CAPI", () => {
  it("si Meta no lo acepta (sin anuncio), lo anota y el flujo sigue", async () => {
    h.evento.mockResolvedValueOnce({ enviado: false, motivo: "sin_anuncio" } as never);
    flujo([
      { node_key: "inicio", node_type: "start", config: { next_node_key: "capi" } },
      { node_key: "capi", node_type: "meta_capi", config: { event_name: "Purchase", value: 99, currency: "MXN", next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Gracias por tu compra", next_node_key: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    await dispatch(texto("chia", "m1"));
    expect(h.evento).toHaveBeenCalledWith(expect.objectContaining({ eventName: "Purchase", value: 99, currency: "MXN" }));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(corrida()).toMatchObject({ status: "completed" });
    expect(h.tables.flow_run_events).toContainEqual(
      expect.objectContaining({
        event_type: "error",
        node_key: "capi",
        payload: expect.objectContaining({ reason: "meta_capi_sin_anuncio" }),
      }),
    );
  });
});

describe("validación de los nodos nuevos", () => {
  const flow = {
    name: "prueba",
    trigger_type: "keyword" as const,
    trigger_config: { keywords: ["chia"], match_type: "contains" as const },
    entry_node_id: "inicio",
    fallback_policy: {},
  };
  const errores = (nodos: typeof CADENA_DELAY) =>
    validateFlowForActivation(flow, nodos as never).filter((i) => i.severity === "error");

  it("la cadena con Smart Delay de 2 h y Meta CAPI es válida (y todo es alcanzable)", () => {
    expect(errores(CADENA_DELAY)).toEqual([]);
    expect(
      validateFlowForActivation(flow, CADENA_DELAY as never).filter((i) => i.severity === "warning"),
    ).toEqual([]);
  });

  it("no acepta una espera de más de 23 h", () => {
    const nodos = structuredClone(CADENA_DELAY);
    (nodos[2].config as { segundos: number }).segundos = 24 * 3600;
    expect(errores(nodos).map((i) => i.field)).toContain("segundos");
  });

  it("Compra sin valor es un error", () => {
    const nodos = structuredClone(CADENA_DELAY);
    nodos[4].config = { event_name: "Purchase", next_node_key: "fin" } as never;
    expect(errores(nodos).map((i) => i.field)).toContain("value");
  });

  it("evento desconocido es un error", () => {
    const nodos = structuredClone(CADENA_DELAY);
    nodos[4].config = { event_name: "Hackeo", next_node_key: "fin" } as never;
    expect(errores(nodos).map((i) => i.field)).toContain("event_name");
  });
});
