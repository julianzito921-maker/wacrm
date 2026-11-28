import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filas: Record<string, unknown> = {};

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: filas[tabla] ?? null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

import { armarVentaLowtrack, enviarVentaLowtrack, LOWTRACK_URL } from "./lowtrack";
import { errorDeClave, esUrlOpenRouter } from "./store";

describe("claves de integraciones", () => {
  it("D-API no acepta pk_live_", () => {
    expect(errorDeClave("dapi", "pk_live_abcdefgh")).toBe("dapi_public_key");
    expect(errorDeClave("dapi", "sk_abcdefgh123")).toBeNull();
  });
  it("rechaza claves cortas", () => {
    expect(errorDeClave("lowtrack", "abc")).toBe("invalid_api_key");
  });
  it("reconoce la URL de OpenRouter", () => {
    expect(esUrlOpenRouter("https://openrouter.ai/api/v1")).toBe(true);
    expect(esUrlOpenRouter("https://api.deepseek.com/v1")).toBe(false);
    expect(esUrlOpenRouter("https://openrouter.ai.evil.com/v1")).toBe(false);
  });
});

describe("armarVentaLowtrack", () => {
  it("arma el payload de la doc con cliente y UTMs", () => {
    expect(
      armarVentaLowtrack({
        event: "sale.approved",
        transactionId: "c1-pagado-2026-11-27",
        amount: 99,
        currency: "mxn",
        producto: "Chía Saciante",
        contacto: { name: "Ana López Ruiz", phone: "+52 1 55 1234 5678", email: "ana@x.mx" },
        atribucion: {
          source: "facebook",
          campaign: "chia-01",
          ctwa_clid: "ARAkLk",
          utm: { utm_medium: "cpc" },
          click_ids: { fbc: "fb.1.1.abc" },
        },
      }),
    ).toEqual({
      event: "sale.approved",
      transaction_id: "c1-pagado-2026-11-27",
      amount: 99,
      currency: "MXN",
      product: { id: "Chía Saciante", name: "Chía Saciante" },
      customer: {
        name: "Ana López Ruiz",
        first_name: "Ana",
        last_name: "López Ruiz",
        phone: "5215512345678",
        email: "ana@x.mx",
      },
      tracking: {
        utm_source: "facebook",
        utm_medium: "cpc",
        utm_campaign: "chia-01",
        fbc: "fb.1.1.abc",
      },
      metadata: { platform: "wacrm", channel: "whatsapp", ctwa_clid: "ARAkLk" },
    });
  });
});

describe("enviarVentaLowtrack", () => {
  beforeEach(() => {
    for (const k of Object.keys(filas)) delete filas[k];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sin token no llama a LowTrack", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await enviarVentaLowtrack({
      accountId: "a1", transactionId: "t1", amount: 99, currency: "MXN",
    });
    expect(r).toEqual({ enviado: false, motivo: "sin_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("manda la venta con Bearer y lee capi_sent", async () => {
    filas.account_integrations = { secret: "enc:tk_abc123" };
    filas.contacts = { name: "Ana", phone: "5215512345678", email: null };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, capi_sent: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await enviarVentaLowtrack({
      accountId: "a1", contactId: "c1", transactionId: "t1", amount: 99, currency: "MXN",
    });
    expect(r).toEqual({ enviado: true, capi: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(LOWTRACK_URL);
    expect(init.headers.Authorization).toBe("Bearer tk_abc123");
    expect(JSON.parse(init.body)).toMatchObject({
      event: "sale.approved", transaction_id: "t1", amount: 99,
      customer: { name: "Ana", phone: "5215512345678" },
    });
  });

  it("una venta repetida (409) no es error", async () => {
    filas.account_integrations = { secret: "enc:tk_abc123" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 409 })));
    const r = await enviarVentaLowtrack({
      accountId: "a1", transactionId: "t1", amount: 99, currency: "MXN",
    });
    expect(r).toEqual({ enviado: false, motivo: "duplicada" });
  });

  it("nunca lanza aunque falle la red", async () => {
    filas.account_integrations = { secret: "enc:tk_abc123" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(
      enviarVentaLowtrack({ accountId: "a1", transactionId: "t1", amount: 99, currency: "MXN" }),
    ).resolves.toMatchObject({ enviado: false, motivo: "error" });
  });
});
