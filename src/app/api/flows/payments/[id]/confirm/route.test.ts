import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeTables } from "@/lib/flows/fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** Se ejecuta tras la primera lectura de la sesión (simula una carrera). */
  trasLeer: null as null | (() => void),
  resume: vi.fn(async () => true),
  venta: vi.fn(async () => "sale-1"),
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async () => ({ accountId: "acct-1", userId: "u-1", role: "admin" })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => {
    const db = createFakeDb(h.tables as FakeTables);
    let leida = false;
    return {
      ...db,
      from: (t: string) => {
        const q = db.from(t) as Record<string, unknown>;
        if (t !== "flow_payment_sessions") return q;
        const maybeSingle = q.maybeSingle as () => Promise<unknown>;
        q.maybeSingle = async () => {
          const r = await maybeSingle();
          if (!leida) {
            leida = true;
            h.trasLeer?.();
          }
          return r;
        };
        return q;
      },
    };
  },
}));

vi.mock("@/lib/flows/engine", () => ({
  resumePaymentGateway: h.resume,
  registrarVentaDeSesionAprobada: h.venta,
}));

import { POST } from "./route";

function llamar(status: "approved" | "rejected" = "approved") {
  return POST(
    new Request("http://localhost/api/flows/payments/ses-1/confirm", {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: "ses-1" }) },
  );
}

beforeEach(() => {
  h.trasLeer = null;
  h.tables = {
    flow_payment_sessions: [
      { id: "ses-1", account_id: "acct-1", flow_run_id: "run-1", status: "pending" },
    ],
    flow_runs: [{ id: "run-1", status: "active", vars: {}, resume_reason: "payment_gateway" }],
  };
});

describe("confirmación manual de pago", () => {
  it("cierra la sesión pendiente y reanuda la corrida", async () => {
    const r = await llamar();
    expect(r.status).toBe(200);
    expect(h.tables.flow_payment_sessions[0].status).toBe("approved");
    expect(h.resume).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-1",
      decision: "approved",
      sessionId: "ses-1",
    });
  });

  it("si un webhook cerró la sesión entre la lectura y el update, responde 409 sin tocar la corrida", async () => {
    h.trasLeer = () => {
      h.tables.flow_payment_sessions[0].status = "rejected";
    };
    const r = await llamar("approved");
    expect(r.status).toBe(409);
    expect(h.tables.flow_payment_sessions[0].status).toBe("rejected");
    expect(h.tables.flow_runs[0]).not.toHaveProperty("next_run_at");
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.venta).not.toHaveBeenCalled();
  });
});
