import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

/**
 * Bloque «Esperar respuesta» (save_reply) estilo Leona: espera con
 * unidades, espera indefinida con válvula de 31 días, buffer de
 * mensajes, cita de la respuesta, reacción 👍 y campo del contacto.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
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
import {
  dispatchInboundToFlows,
  resumeDueRuns,
  resumeSaveReplyTimeout,
} from "./engine";
import type { ParsedInbound } from "./types";

const DIA = 24 * 3_600_000;

function flujo(cfg: Record<string, unknown>) {
  h.tables.flows.push({
    id: "flow-1",
    account_id: "acct-1",
    user_id: "u-1",
    status: "active",
    entry_node_id: "inicio",
    fallback_policy: { on_timeout_hours: 24 },
    created_at: "2026-01-01T00:00:00Z",
    trigger_type: "keyword",
    trigger_config: { keywords: ["chia"], match_type: "contains" },
  });
  h.tables.flow_nodes.push(
    { flow_id: "flow-1", node_key: "inicio", node_type: "start", config: { next_node_key: "espera" } },
    {
      flow_id: "flow-1",
      node_key: "espera",
      node_type: "save_reply",
      config: {
        var_key: "resp",
        contesto_next: "si",
        no_contesto_next: "no",
        ...cfg,
      },
    },
    {
      flow_id: "flow-1",
      node_key: "si",
      node_type: "send_message",
      config: { text: "gracias {{vars.resp}}", next_node_key: "" },
    },
    {
      flow_id: "flow-1",
      node_key: "no",
      node_type: "send_message",
      config: { text: "sin respuesta", next_node_key: "" },
    },
  );
}

const texto = (t: string, id: string): ParsedInbound => ({
  kind: "text",
  text: t,
  meta_message_id: id,
});

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

const corrida = () => h.tables.flow_runs[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  h.sendText.mockResolvedValue({ whatsapp_message_id: "wamid.text" });
  h.sendMedia.mockResolvedValue({ whatsapp_message_id: "wamid.media" });
  h.reaccion.mockResolvedValue(undefined);
  h.escribiendo.mockResolvedValue(undefined);
  h.tables = {
    flows: [],
    flow_nodes: [],
    flow_runs: [],
    flow_run_events: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", name: "Ana", phone: "521555" }],
    custom_fields: [],
    contact_custom_values: [],
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

describe("Esperar respuesta — espera con unidades", () => {
  it("estaciona con el tiempo en segundos y avanza al responder, citando el mensaje", async () => {
    flujo({ espera_segundos: 120, citar_respuesta: true });
    await dispatch(texto("chia", "m0"));

    const run = corrida();
    expect(run.resume_reason).toBe("reply_timeout");
    const delta = new Date(String(run.next_run_at)).getTime() - Date.now();
    expect(delta).toBeGreaterThan(110_000);
    expect(delta).toBeLessThan(130_000);

    const r = await dispatch(texto("hola", "m1"));
    expect(r.consumed).toBe(true);
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "gracias hola", contextMessageId: "m1" }),
    );
    expect(run.vars).toMatchObject({ resp: "hola" });
    expect(run.vars).not.toHaveProperty("__reply_to");
    expect(run.status).toBe("completed");
  });
});

describe("Esperar respuesta — indefinido", () => {
  it("no tiene salida por timeout y la válvula de 31 días cierra limpio", async () => {
    flujo({ esperar_indefinido: true, espera_segundos: 60, no_contesto_next: "" });
    await dispatch(texto("chia", "m0"));

    const run = corrida();
    expect(run.resume_reason).toBe("awaiting_reply");
    const delta = new Date(String(run.next_run_at)).getTime() - Date.now();
    expect(delta).toBeGreaterThan(31 * DIA - 60_000);
    expect(await resumeSaveReplyTimeout(supabaseAdmin(), String(run.id))).toBe(false);

    const retomadas = await resumeDueRuns(
      supabaseAdmin(),
      new Date(Date.now() + 32 * DIA),
    );
    expect(retomadas).toBe(1);
    expect(run.status).toBe("completed");
    expect(run.end_reason).toBe("espera_indefinida_vencida");
  });
});

describe("Esperar respuesta — buffer de mensajes", () => {
  it("agrupa varios mensajes, reacciona una vez y cita el primero", async () => {
    flujo({
      espera_segundos: 300,
      buffer_segundos: 10,
      citar_respuesta: true,
      reaccionar: true,
    });
    await dispatch(texto("chia", "m0"));

    const r1 = await dispatch(texto("uno", "m1"));
    expect(r1.consumed).toBe(true);
    const run = corrida();
    expect(run.resume_reason).toBe("reply_buffer");
    expect((run.vars as { __buffer?: { textos: string[] } }).__buffer?.textos).toEqual([
      "uno",
    ]);
    expect(h.reaccion).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();

    await dispatch(texto("dos", "m2"));
    expect((run.vars as { __buffer?: { textos: string[] } }).__buffer?.textos).toEqual([
      "uno",
      "dos",
    ]);
    expect(h.sendText).not.toHaveBeenCalled();

    const retomadas = await resumeDueRuns(
      supabaseAdmin(),
      new Date(Date.now() + 11_000),
    );
    expect(retomadas).toBe(1);
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "gracias uno\ndos",
        contextMessageId: "m1",
      }),
    );
    expect(h.reaccion).toHaveBeenCalledTimes(1);
    expect(run.vars).toMatchObject({ resp: "uno\ndos" });
    expect(run.vars).not.toHaveProperty("__buffer");
    expect(run.status).toBe("completed");
  });
});

describe("Esperar respuesta — campo del contacto", () => {
  it("guarda en un campo personalizado de la cuenta", async () => {
    h.tables.custom_fields.push({
      id: "cf-1",
      account_id: "acct-1",
      field_name: "Ciudad",
    });
    flujo({ espera_segundos: 120, campo_contacto: "custom:cf-1" });
    await dispatch(texto("chia", "m0"));
    await dispatch(texto("Madrid", "m1"));

    expect(h.tables.contact_custom_values).toContainEqual(
      expect.objectContaining({
        contact_id: "ct-1",
        custom_field_id: "cf-1",
        value: "Madrid",
      }),
    );
  });

  it("guarda en un campo base del contacto", async () => {
    flujo({ espera_segundos: 120, campo_contacto: "name" });
    await dispatch(texto("chia", "m0"));
    await dispatch(texto("Marta", "m1"));

    expect(h.tables.contacts[0]).toMatchObject({ name: "Marta" });
  });
});

describe("Esperar respuesta — salidas sin conectar (como Leona)", () => {
  it("«si contesta» vacía: guarda la respuesta, termina y deja el mensaje al agente", async () => {
    flujo({ espera_segundos: 120, contesto_next: "" });
    await dispatch(texto("chia", "m0"));
    const r = await dispatch(texto("sí quiero", "m1"));
    const run = corrida();
    expect(r.consumed).toBe(false);
    expect(run.status).toBe("completed");
    expect(run.end_reason).toBe("contesto_sin_salida");
    expect(run.vars).toMatchObject({ resp: "sí quiero" });
  });

  it("«si no responde» vacía: al vencerse la espera la conversación termina", async () => {
    flujo({ espera_segundos: 60, no_contesto_next: "" });
    await dispatch(texto("chia", "m0"));
    const run = corrida();
    run.last_advanced_at = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(await resumeSaveReplyTimeout(supabaseAdmin(), String(run.id))).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.end_reason).toBe("timeout_sin_salida");
  });
});
