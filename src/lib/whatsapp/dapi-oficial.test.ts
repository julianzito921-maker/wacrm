import { afterEach, describe, expect, it, vi } from "vitest";
import { aWebhookMeta, esSesionOficial, plantillaComoMeta } from "./dapi";
import { sendTemplateMessage } from "./meta-api";

const OFICIAL = "dapi:cloud-1234abcd";
const base = {
  event: "messages.received",
  sessionId: "cloud-1234abcd",
  data: { id: "W1", timestamp: 1769295600000, from: { jid: "5215512345678@s.whatsapp.net", name: "Ana" } },
};
const mensaje = (data: Record<string, unknown>) => {
  const r = aWebhookMeta({ ...base, data: { ...base.data, ...data } }, OFICIAL) as {
    entry: Array<{ changes: Array<{ value: { messages?: Array<Record<string, unknown>>; statuses?: unknown[] } }> }>;
  };
  return r.entry[0].changes[0].value;
};

describe("API oficial por D-API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("distingue números oficiales de los de QR", () => {
    expect(esSesionOficial(OFICIAL)).toBe(true);
    expect(esSesionOficial("dapi:wacrm-abc")).toBe(false);
    expect(esSesionOficial("123456")).toBe(false);
  });

  it("respuesta a botón → interactive.button_reply (el flujo avanza por id)", () => {
    expect(mensaje({ type: "buttons_response", selected_id: "si", message: "Sí" }).messages![0]).toMatchObject({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "si", title: "Sí" } },
    });
  });

  it("respuesta a lista → interactive.list_reply", () => {
    expect(mensaje({ type: "list_response", selected_row_id: "op2", selected_title: "OXXO" }).messages![0]).toMatchObject({
      interactive: { type: "list_reply", list_reply: { id: "op2", title: "OXXO" } },
    });
  });

  it("botón de plantilla → button.payload", () => {
    expect(
      mensaje({ type: "template_button_reply", selected_id: "QUIERO", selected_display_text: "Quiero" }).messages![0],
    ).toMatchObject({ type: "button", button: { payload: "QUIERO", text: "Quiero" } });
  });

  it("mensaje rechazado → status failed con código", () => {
    const v = aWebhookMeta(
      { event: "message.failed", sessionId: "cloud-1234abcd", data: { message_id: "M9", remote_jid: "5215512345678@s.whatsapp.net", error: { code: 131047, title: "Re-engagement message" } } },
      OFICIAL,
    ) as { entry: Array<{ changes: Array<{ value: { statuses: unknown[] } }> }> };
    expect(v.entry[0].changes[0].value.statuses[0]).toMatchObject({
      id: "M9",
      status: "failed",
      errors: [{ code: 131047, title: "Re-engagement message" }],
    });
  });

  it("manda plantillas por D-API con componentes de Meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "T1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sendTemplateMessage({
      phoneNumberId: OFICIAL,
      accessToken: "sk_clave",
      to: "+52 55 1234 5678",
      templateName: "bienvenida",
      language: "es_MX",
      params: ["Ana"],
    } as Parameters<typeof sendTemplateMessage>[0]);
    expect(r).toEqual({ messageId: "T1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.d-api.cloud/api/v1/messages/send/template");
    expect(JSON.parse(init.body)).toEqual({
      sessionId: "cloud-1234abcd",
      to: "525512345678",
      template: {
        name: "bienvenida",
        language: "es_MX",
        components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
      },
    });
  });

  it("en un número de QR las plantillas siguen bloqueadas", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      sendTemplateMessage({ phoneNumberId: "dapi:wacrm-x", accessToken: "k", to: "1", templateName: "x" } as Parameters<typeof sendTemplateMessage>[0]),
    ).rejects.toThrow(/QR/);
  });

  it("convierte la plantilla de D-API a la forma de Meta", () => {
    expect(
      plantillaComoMeta({
        id: "t1", name: "promo", language: "es_MX", status: "APPROVED", category: "MARKETING",
        body: "Hola {{1}}", headerFormat: "IMAGE", footerText: "Baja: STOP", buttons: [{ type: "QUICK_REPLY", text: "Quiero" }],
      }),
    ).toEqual({
      id: "t1", name: "promo", language: "es_MX", status: "APPROVED", category: "MARKETING",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Hola {{1}}" },
        { type: "FOOTER", text: "Baja: STOP" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quiero" }] },
      ],
    });
  });
});
