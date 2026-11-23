import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

/**
 * Migración 079: los bloques Kanban, Template WhatsApp y Botón Pago /
 * SPEI recorridos de punta a punta por el motor, con la base falsa.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.buttons" })),
  sendTemplate: vi.fn(async () => ({ whatsapp_message_id: "wamid.template" })),
  automations: vi.fn(async () => 1),
  leer: vi.fn(),
  etiquetar: vi.fn(async () => undefined),
  guardarValor: vi.fn(async () => undefined),
}));

vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.media" })),
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.list" })),
  mostrarEscribiendo: vi.fn(async () => undefined),
  loadAccountMetaCredentials: vi.fn(async () => ({ phoneNumberId: "pn", accessToken: "tok" })),
}));

vi.mock("@/lib/automations/meta-send", () => ({ engineSendTemplate: h.sendTemplate }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: h.automations }));
vi.mock("@/lib/ventas/conversiones", () => ({
  enviarEventoMeta: vi.fn(async () => ({ enviado: true })),
  guardarValor: h.guardarValor,
}));
vi.mock("@/lib/ventas/comprobante", async () => {
  const real = await vi.importActual<typeof import("@/lib/ventas/comprobante")>("@/lib/ventas/comprobante");
  return { ...real, leerComprobanteDeMedio: h.leer, etiquetar: h.etiquetar };
});

import { supabaseAdmin } from "./admin-client";
import { dispatchInboundToFlows, resumeDueRuns } from "./engine";
import { TEXTO_NO_ES_COMPROBANTE } from "./bloques";
import type { ParsedInbound } from "./types";

const HOUR = 3_600_000;

function flujo(nodos: Record<string, unknown>[]) {
  h.tables.flows = [
    {
      id: "flow-1",
      account_id: "acct-1",
      user_id: "u-1",
      status: "active",
      trigger_type: "keyword",
      trigger_config: { keywords: ["quiero"], match_type: "contains" },
      entry_node_id: nodos[0].node_key,
      fallback_policy: { on_timeout_hours: 24 },
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  h.tables.flow_nodes = nodos.map((n) => ({ flow_id: "flow-1", ...n }));
}

const texto = (t: string, id: string): ParsedInbound => ({ kind: "text", text: t, meta_message_id: id });
const imagen = (id: string, pie = ""): Extract<ParsedInbound, { kind: "media" }> => ({
  kind: "media",
  media_type: "image",
  media_id: `media-${id}`,
  mime_type: "image/jpeg",
  text: pie,
  meta_message_id: id,
});

const dispatch = (message: ParsedInbound) =>
  dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });

const corrida = () => h.tables.flow_runs[0] as Record<string, unknown>;
const textosEnviados = () =>
  h.sendText.mock.calls.map((c) => (c as unknown as [{ text: string }])[0].text);

beforeEach(() => {
  vi.clearAllMocks();
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
    contacts: [{ id: "ct-1", account_id: "acct-1", name: "Ana", phone: "5215512345678", email: "", company: "" }],
    contact_custom_values: [],
    contact_notes: [],
    payment_details: [],
    payment_receipts: [],
    accounts: [{ id: "acct-1", default_currency: "MXN" }],
    pipeline_stages: [
      { id: "st-nuevo", pipeline_id: "pl-1", "pipelines.account_id": "acct-1" },
      { id: "st-pagado", pipeline_id: "pl-1", "pipelines.account_id": "acct-1" },
    ],
    deals: [],
  };
});

// ============================================================
// Template WhatsApp
// ============================================================

describe("Template WhatsApp", () => {
  it("manda la plantilla con {{1}} = nombre del contacto y {{2}} fijo", async () => {
    flujo([
      { node_key: "tpl", node_type: "send_template", config: {
        template_name: "seguimiento", language: "es_MX",
        variables: { "1": "{{contact.name}}", "2": "chía" }, next_node_key: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    await dispatch(texto("quiero", "m1"));
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: "seguimiento", language: "es_MX", params: ["Ana", "chía"] }),
    );
    expect(corrida()).toMatchObject({ status: "completed" });
  });

  it("si Meta rechaza la plantilla, la corrida falla con su motivo", async () => {
    h.sendTemplate.mockRejectedValueOnce(new Error("plantilla pausada"));
    flujo([
      { node_key: "tpl", node_type: "send_template", config: {
        template_name: "x", language: "es_MX", variables: {}, next_node_key: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    await dispatch(texto("quiero", "m1"));
    expect(corrida()).toMatchObject({ status: "failed", end_reason: "send_template_failed" });
  });
});

// ============================================================
// Kanban
// ============================================================

describe("Kanban", () => {
  const nodosKanban = (crear = true) => [
    { node_key: "kb", node_type: "move_kanban", config: {
      pipeline_id: "pl-1", stage_id: "st-pagado", crear_si_no_existe: crear,
      titulo: "{{contact.name}}", next_node_key: "fin" } },
    { node_key: "fin", node_type: "end", config: {} },
  ];

  it("mueve el trato abierto del contacto y dispara deal_stage_changed", async () => {
    h.tables.deals = [{ id: "deal-1", account_id: "acct-1", contact_id: "ct-1", pipeline_id: "pl-1", stage_id: "st-nuevo", status: "open" }];
    flujo(nodosKanban());
    await dispatch(texto("quiero", "m1"));
    expect(h.tables.deals[0]).toMatchObject({ stage_id: "st-pagado" });
    expect(h.automations).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "deal_stage_changed",
        context: expect.objectContaining({ deal_id: "deal-1", stage_id: "st-pagado", from_stage_id: "st-nuevo" }),
      }),
    );
    expect(corrida()).toMatchObject({ status: "completed" });
  });

  it("si no tiene trato, lo crea con el nombre del contacto y la moneda de la cuenta", async () => {
    flujo(nodosKanban());
    await dispatch(texto("quiero", "m1"));
    expect(h.tables.deals).toHaveLength(1);
    expect(h.tables.deals[0]).toMatchObject({
      contact_id: "ct-1", stage_id: "st-pagado", title: "Ana", currency: "MXN", status: "open",
    });
  });

  it("con «crear» apagado y sin trato, no crea nada y el flujo sigue", async () => {
    flujo(nodosKanban(false));
    await dispatch(texto("quiero", "m1"));
    expect(h.tables.deals).toHaveLength(0);
    expect(h.automations).not.toHaveBeenCalled();
    expect(corrida()).toMatchObject({ status: "completed" });
  });

  it("una etapa de otra cuenta no se toca: se anota el error y el flujo sigue", async () => {
    h.tables.pipeline_stages = [{ id: "st-pagado", pipeline_id: "pl-1", "pipelines.account_id": "otra" }];
    flujo(nodosKanban());
    await dispatch(texto("quiero", "m1"));
    expect(h.tables.deals).toHaveLength(0);
    expect(h.tables.flow_run_events).toContainEqual(
      expect.objectContaining({ event_type: "error", payload: expect.objectContaining({ reason: "move_kanban_failed" }) }),
    );
    expect(corrida()).toMatchObject({ status: "completed" });
  });
});

// ============================================================
// Botón Pago / SPEI
// ============================================================

const nodosPago = (extra: Record<string, unknown> = {}) => [
  { node_key: "pago", node_type: "send_payment", config: {
    clabe: "012180001234567890", beneficiario: "Editorial Nova", banco: "STP", monto: 99,
    con_boton: false, espera_minutos: 120, etiqueta_al_aprobar: "pagado",
    aprobado_next: "gracias", rechazado_next: "revisar", ...extra } },
  { node_key: "gracias", node_type: "send_message", config: { text: "¡Pago confirmado!", next_node_key: "fin" } },
  { node_key: "revisar", node_type: "send_message", config: { text: "Lo reviso a mano", next_node_key: "fin" } },
  { node_key: "fin", node_type: "end", config: {} },
];

const lectura = (extra: Record<string, unknown> = {}) => ({
  es_comprobante: true, monto: 99, banco_destino: "STP", ultimos_digitos_destino: "7890",
  estado: "exitosa", fecha: "2026-11-22", referencia: "REF123456", tipo: "spei", ...extra,
});

describe("Botón Pago / SPEI", () => {
  it("manda los datos SPEI en TEXTO (sin botón por defecto) y espera el comprobante", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero pagar", "m1"));
    expect(h.sendButtons).not.toHaveBeenCalled();
    expect(textosEnviados()[0]).toContain("012180001234567890");
    expect(corrida()).toMatchObject({ status: "active", current_node_key: "pago", resume_reason: "payment_timeout" });
  });

  it("con el botón encendido manda «Ya pagué ✅»", async () => {
    flujo(nodosPago({ con_boton: true }));
    await dispatch(texto("quiero", "m1"));
    expect(h.sendButtons).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: expect.arrayContaining([expect.objectContaining({ id: "pago_ya" })]) }),
    );
  });

  it("comprobante válido → Aprobado: etiqueta «pagado», guarda el monto y registra el comprobante", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    h.leer.mockResolvedValueOnce(lectura());
    const r = await dispatch(imagen("m2"));
    expect(r.consumed).toBe(true);
    expect(textosEnviados()).toContain("¡Pago confirmado!");
    expect(h.etiquetar).toHaveBeenCalledWith("acct-1", "u-1", "ct-1", "pagado");
    expect(h.guardarValor).toHaveBeenCalledWith("acct-1", "u-1", "ct-1", "monto_pagado", "99");
    expect(h.tables.payment_receipts).toEqual([
      expect.objectContaining({ resultado: "aprobado", referencia: "REF123456", monto: 99, flow_run_id: corrida().id }),
    ]);
    expect(corrida()).toMatchObject({ status: "completed", next_run_at: null, vars: expect.objectContaining({ pago_resultado: "aprobado" }) });
  });

  it("PDF con otro monto → Rechazado, sin etiqueta «pagado»", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    h.leer.mockResolvedValueOnce(lectura({ monto: 59 }));
    await dispatch({ ...imagen("m2"), media_type: "document", mime_type: "application/pdf" });
    expect(textosEnviados()).toContain("Lo reviso a mano");
    expect(h.etiquetar).not.toHaveBeenCalled();
    expect(h.tables.payment_receipts[0]).toMatchObject({ resultado: "rechazado" });
    expect(h.tables.contact_notes[0].note_text).toContain("RECHAZADO");
  });

  it("referencia ya aprobada en la cuenta → Rechazado (antifraude)", async () => {
    h.tables.payment_receipts = [{ account_id: "acct-1", referencia: "REF123456", resultado: "aprobado" }];
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    h.leer.mockResolvedValueOnce(lectura());
    await dispatch(imagen("m2"));
    expect(textosEnviados()).toContain("Lo reviso a mano");
    expect(h.etiquetar).not.toHaveBeenCalled();
  });

  it("una foto que no es comprobante → se le pide la captura y sigue esperando", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    h.leer.mockResolvedValueOnce(lectura({ es_comprobante: false }));
    const r = await dispatch(imagen("m2"));
    expect(r).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(textosEnviados()).toContain(TEXTO_NO_ES_COMPROBANTE);
    expect(corrida()).toMatchObject({ status: "active", current_node_key: "pago" });
    expect(h.tables.payment_receipts).toHaveLength(0);
  });

  it("texto libre mientras espera: el flujo sigue siendo dueño y no contesta", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    const antes = h.sendText.mock.calls.length;
    const r = await dispatch(texto("¿y si pago mañana?", "m2"));
    expect(r).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(h.sendText.mock.calls.length).toBe(antes);
  });

  it("si no llega el comprobante a tiempo → Rechazado / Timeout por el cron", async () => {
    flujo(nodosPago());
    await dispatch(texto("quiero", "m1"));
    const n = await resumeDueRuns(supabaseAdmin(), new Date(Date.now() + 2 * HOUR + 60_000));
    expect(n).toBe(1);
    expect(textosEnviados()).toContain("Lo reviso a mano");
    expect(corrida()).toMatchObject({ status: "completed", vars: expect.objectContaining({ pago_resultado: "timeout" }) });
  });

  it("sin CLABE ni «Datos de pago» de la cuenta, la corrida falla sin mandar nada", async () => {
    flujo(nodosPago({ clabe: "" }));
    await dispatch(texto("quiero", "m1"));
    expect(h.sendText).not.toHaveBeenCalled();
    expect(corrida()).toMatchObject({ status: "failed", end_reason: "pago_sin_clabe_o_monto" });
  });

  it("toma la CLABE de «Datos de pago» de la cuenta si el nodo no la trae", async () => {
    h.tables.payment_details = [{ account_id: "acct-1", clabe: "646180157000000004", holder: "Editorial Nova", bank: "STP", activo: true }];
    flujo(nodosPago({ clabe: "" }));
    await dispatch(texto("quiero", "m1"));
    expect(textosEnviados()[0]).toContain("646180157000000004");
  });
});

describe("imágenes en nodos que no son de pago", () => {
  it("cuentan como texto con su pie de foto, igual que antes de la 079", async () => {
    flujo([
      { node_key: "q", node_type: "save_reply", config: {
        prompt_text: "¿Cómo te llamas?", var_key: "nombre", espera_minutos: 30,
        contesto_next: "fin", no_contesto_next: "fin" } },
      { node_key: "fin", node_type: "end", config: {} },
    ]);
    await dispatch(texto("quiero", "m1"));
    await dispatch(imagen("m2", "Soy Ana"));
    expect(h.leer).not.toHaveBeenCalled();
    expect(corrida()).toMatchObject({ status: "completed", vars: { nombre: "Soy Ana" } });
  });
});
