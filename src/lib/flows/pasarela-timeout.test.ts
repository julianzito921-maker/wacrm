import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeTables } from "./fake-db.test-helper";

/**
 * Pasarela de pago: el cron llega a `resumePaymentGatewayTimeout` también
 * cuando el webhook o la confirmación manual ya cerraron la sesión (ponen
 * `next_run_at = ahora` como respaldo). La decisión debe salir de la
 * sesión, no ser siempre «expired».
 */

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.text" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.media" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.buttons" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.list" })),
  mostrarEscribiendo: vi.fn(async () => undefined),
  loadAccountMetaCredentials: vi.fn(async () => ({ phoneNumberId: "pn", accessToken: "tok" })),
}));
vi.mock("@/lib/automations/meta-send", () => ({ engineSendTemplate: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: vi.fn(async () => 0) }));
vi.mock("@/lib/ventas/conversiones", () => ({
  enviarEventoMeta: vi.fn(async () => ({ enviado: true })),
  guardarValor: vi.fn(async () => undefined),
}));

import { resumeDueRuns } from "./engine";

let tables: FakeTables;

function preparar(statusSesion: string) {
  tables = {
    flows: [{ id: "flow-1", account_id: "acct-1", user_id: "u-1", status: "active" }],
    // Sin salidas conectadas: la corrida se cierra con
    // `payment_gateway_<decisión>`, que deja ver qué decidió el cron.
    flow_nodes: [{ flow_id: "flow-1", node_key: "gw", node_type: "payment_gateway", config: {} }],
    flow_runs: [
      {
        id: "run-1",
        flow_id: "flow-1",
        account_id: "acct-1",
        user_id: "u-1",
        contact_id: "ct-1",
        status: "active",
        current_node_key: "gw",
        resume_reason: "payment_gateway",
        next_run_at: new Date(Date.now() - 60_000).toISOString(),
        vars: {},
        transition_seq: 0,
      },
    ],
    flow_run_events: [],
    flow_payment_sessions: [
      {
        id: "ses-1",
        account_id: "acct-1",
        flow_run_id: "run-1",
        node_key: "gw",
        status: statusSesion,
        amount: 99,
        currency: "MXN",
        sale_id: "sale-1",
        created_at: new Date().toISOString(),
      },
    ],
  };
}

const corrida = () => tables.flow_runs[0] as Record<string, unknown>;
const sesionGw = () => tables.flow_payment_sessions[0] as Record<string, unknown>;

describe("timeout de la pasarela de pago", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("si la sesión ya está aprobada, el cron sigue por aprobado y no la expira", async () => {
    preparar("approved");
    const db = createFakeDb(tables);
    expect(await resumeDueRuns(db as never)).toBe(1);
    expect(corrida()).toMatchObject({ status: "completed", end_reason: "payment_gateway_approved" });
    expect(sesionGw().status).toBe("approved");
  });

  it("si la sesión ya está rechazada, el cron sigue por rechazado", async () => {
    preparar("rejected");
    const db = createFakeDb(tables);
    await resumeDueRuns(db as never);
    expect(corrida()).toMatchObject({ end_reason: "payment_gateway_rejected" });
    expect(sesionGw().status).toBe("rejected");
  });

  it("si la sesión sigue pendiente, la expira y sigue por timeout", async () => {
    preparar("pending");
    const db = createFakeDb(tables);
    await resumeDueRuns(db as never);
    expect(corrida()).toMatchObject({ end_reason: "payment_gateway_expired" });
    expect(sesionGw().status).toBe("expired");
  });
});
