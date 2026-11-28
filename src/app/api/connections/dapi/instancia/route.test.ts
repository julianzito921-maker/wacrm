import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  borradas: [] as string[],
  webhookOficial: vi.fn(),
  webhookQr: vi.fn(),
  oficial: vi.fn(),
  qr: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({ accountId: "acc-1", userId: "u-1" }),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}));
vi.mock("@/lib/whatsapp/encryption", () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock("@/lib/flows/pagos", () => ({ urlBaseWebhook: () => "https://crm.test" }));
vi.mock("@/lib/whatsapp/dapi", async (orig) => {
  const real = await orig<typeof import("@/lib/whatsapp/dapi")>();
  return {
    ...real,
    obtenerConexionOficial: h.oficial,
    obtenerQr: h.qr,
    configurarWebhookOficial: h.webhookOficial,
    actualizarWebhookSesion: h.webhookQr,
  };
});
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: null }),
        then: (r: (v: unknown) => void) => r({ count: 0 }),
        insert: (fila: Record<string, unknown>) => {
          const nueva = { id: "conn-9", ...fila };
          h.filas.push(nueva);
          return { select: () => ({ single: async () => ({ data: nueva, error: null }) }) };
        },
        delete: () => ({ eq: async (_: string, id: string) => { h.borradas.push(id); return {}; } }),
      });
      return q;
    },
  }),
}));

import { POST } from "./route";
import { DapiError } from "@/lib/whatsapp/dapi";

const pedir = (body: Record<string, unknown>) =>
  POST(new Request("https://crm.test/api/connections/dapi/instancia", { method: "POST", body: JSON.stringify(body) }));

describe("conectar instancia de D-API con Instance ID + API Key", () => {
  beforeEach(() => {
    h.filas.length = 0;
    h.borradas.length = 0;
    vi.clearAllMocks();
  });

  it("número oficial: valida, crea la isla con WABA y apunta el webhook", async () => {
    h.oficial.mockResolvedValue({ wabaId: "W1", phoneNumberId: "P1", telefono: "5215512345678", nombre: "Ventas", calidad: "GREEN" });
    const res = await pedir({ name: "Atención", instanceId: "cloud-abc123", apiKey: "sk_instancia_123" });
    expect(res.status).toBe(201);
    expect(h.filas[0]).toMatchObject({
      name: "Atención",
      provider: "dapi",
      phone_number_id: "dapi:cloud-abc123",
      waba_id: "W1",
      display_phone_number: "+5215512345678",
      access_token: "enc:sk_instancia_123",
      status: "connected",
    });
    expect(h.webhookOficial).toHaveBeenCalledWith(
      "sk_instancia_123",
      "cloud-abc123",
      expect.stringMatching(/^https:\/\/crm\.test\/api\/whatsapp\/dapi\/conn-9\/[0-9a-f]{48}$/),
    );
  });

  it("instancia de QR: usa el webhook de sesión", async () => {
    h.qr.mockResolvedValue({ status: "connected", qrImage: null });
    const res = await pedir({ instanceId: "d-api-a1", apiKey: "sk_instancia_123" });
    expect(res.status).toBe(201);
    expect(h.webhookQr).toHaveBeenCalledWith("sk_instancia_123", "d-api-a1", expect.any(String));
  });

  it("clave equivocada → error claro y no crea nada", async () => {
    h.oficial.mockRejectedValue(new DapiError("Unauthorized", 401));
    const res = await pedir({ instanceId: "cloud-abc123", apiKey: "sk_mala_12345" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_api_key");
    expect(h.filas).toHaveLength(0);
  });

  it("si D-API no acepta el webhook, deshace la conexión", async () => {
    h.oficial.mockResolvedValue({ wabaId: "W1", phoneNumberId: null, telefono: "", nombre: "", calidad: null });
    h.webhookOficial.mockRejectedValue(new Error("boom"));
    const res = await pedir({ instanceId: "cloud-abc123", apiKey: "sk_instancia_123" });
    expect(res.status).toBe(502);
    expect(h.borradas).toEqual(["conn-9"]);
  });

  it("rechaza la clave pública pk_live_", async () => {
    const res = await pedir({ instanceId: "cloud-abc123", apiKey: "pk_live_1234567890" });
    expect((await res.json()).error).toBe("invalid_api_key");
  });
});
