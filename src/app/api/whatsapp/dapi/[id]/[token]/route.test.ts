import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMetaWebhookSignature } from "@/lib/whatsapp/webhook-signature";

const fila = {
  id: "conn-1",
  phone_number_id: "dapi:wacrm-abc123",
  verify_token: "enc:secreto-url",
  app_secret: "enc:secreto-firma",
  status: "disconnected",
};
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: fila }) }),
      }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));
vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));
const webhookMeta = vi.fn(async (_req: Request) => new Response("ok"));
vi.mock("../../../webhook/route", () => ({ POST: (req: Request) => webhookMeta(req) }));

import { POST } from "./route";

function llamar(token: string, body: unknown) {
  return POST(
    new Request(`https://crm.test/api/whatsapp/dapi/conn-1/${token}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "conn-1", token }) },
  );
}

const mensaje = {
  event: "messages.received",
  sessionId: "wacrm-abc123",
  data: {
    id: "3EB0AAA",
    type: "text",
    message: "Hola",
    timestamp: 1769295600000,
    from: { jid: "5215512345678@s.whatsapp.net", name: "Ana" },
  },
};

describe("webhook de D-API", () => {
  beforeEach(() => {
    webhookMeta.mockClear();
    updates.length = 0;
  });

  it("rechaza un secreto de URL equivocado", async () => {
    const res = await llamar("otro-secreto", mensaje);
    expect(res.status).toBe(404);
    expect(webhookMeta).not.toHaveBeenCalled();
  });

  it("rechaza otra sesión aunque el secreto sea correcto", async () => {
    const res = await llamar("secreto-url", { ...mensaje, sessionId: "otra" });
    expect(res.status).toBe(404);
    expect(webhookMeta).not.toHaveBeenCalled();
  });

  it("pasa el mensaje al webhook de Meta, firmado con el secreto de la isla", async () => {
    const res = await llamar("secreto-url", mensaje);
    expect(res.status).toBe(200);
    expect(webhookMeta).toHaveBeenCalledTimes(1);
    const req = webhookMeta.mock.calls[0][0];
    const raw = await req.text();
    expect(
      verifyMetaWebhookSignature(raw, req.headers.get("x-hub-signature-256"), ["secreto-firma"]),
    ).toBe(true);
    expect(JSON.parse(raw).entry[0].changes[0].value.metadata.phone_number_id).toBe(
      "dapi:wacrm-abc123",
    );
  });

  it("marca la conexión conectada con su número", async () => {
    const res = await llamar("secreto-url", {
      event: "connection.status",
      sessionId: "wacrm-abc123",
      data: { status: "connected", jid: "5215512345678@s.whatsapp.net" },
    });
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({
      status: "connected",
      phone_number: "5215512345678",
      display_phone_number: "+5215512345678",
    });
    expect(webhookMeta).not.toHaveBeenCalled();
  });
});
