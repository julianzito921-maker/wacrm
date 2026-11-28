import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aWebhookMeta,
  claveValida,
  esDapi,
  idDelEnvio,
  leerMediaIdDapi,
  mediaIdDapi,
  numeroDeJid,
  textoDeMenu,
} from "./dapi";
import {
  downloadMedia,
  getMediaUrl,
  getPhoneNumberHealth,
  sendInteractiveButtons,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
} from "./meta-api";

const PNID = "dapi:wacrm-abc123";

function respuesta(json: unknown) {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("dapi helpers", () => {
  it("reconoce islas D-API por prefijo", () => {
    expect(esDapi(PNID)).toBe(true);
    expect(esDapi("123456789")).toBe(false);
    expect(esDapi(null)).toBe(false);
  });

  it("rechaza la clave pública pk_live_", () => {
    expect(claveValida("pk_live_1234567890")).toBe(false);
    expect(claveValida("sk_9f8e7d6c5b4a")).toBe(true);
  });

  it("saca el número del JID", () => {
    expect(numeroDeJid("5215512345678@s.whatsapp.net")).toBe("5215512345678");
    expect(numeroDeJid("5215512345678:12@s.whatsapp.net")).toBe("5215512345678");
  });

  it("encuentra el id del envío en las formas usuales", () => {
    expect(idDelEnvio({ messageId: "A1" })).toBe("A1");
    expect(idDelEnvio({ data: { key: { id: "B2" } } })).toBe("B2");
    expect(idDelEnvio({})).toMatch(/^dapi-/);
  });

  it("guarda y lee el enlace de media de D-API", () => {
    const id = mediaIdDapi("https://media.d-api.cloud/v1/tok.jpg", "image/jpeg");
    expect(leerMediaIdDapi(id)).toEqual({
      url: "https://media.d-api.cloud/v1/tok.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("no acepta media de otro host (SSRF)", () => {
    const id = mediaIdDapi("https://evil.example/x.jpg", "image/jpeg");
    expect(leerMediaIdDapi(id)).toBeNull();
  });

  it("arma el menú numerado", () => {
    expect(
      textoDeMenu({ bodyText: "¿Qué buscas?", opciones: ["Precio", "Envío"] }),
    ).toBe("¿Qué buscas?\n\n1. Precio\n2. Envío");
  });
});

describe("aWebhookMeta", () => {
  const texto = {
    event: "messages.received",
    sessionId: "wacrm-abc123",
    data: {
      id: "3EB0AAA",
      type: "text",
      message: "Hola",
      timestamp: 1769295600000,
      fromMe: false,
      is_group: false,
      from: { jid: "5215512345678@s.whatsapp.net", name: "Ana" },
    },
  };

  it("traduce un texto entrante al formato de Meta", () => {
    const body = aWebhookMeta(texto, PNID) as {
      entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }>;
    };
    const value = body.entry[0].changes[0].value;
    expect(value.metadata).toEqual({ display_phone_number: "", phone_number_id: PNID });
    expect(value.contacts).toEqual([{ profile: { name: "Ana" }, wa_id: "5215512345678" }]);
    expect(value.messages).toEqual([
      {
        id: "3EB0AAA",
        from: "5215512345678",
        timestamp: "1769295600",
        type: "text",
        text: { body: "Hola" },
      },
    ]);
  });

  it("ignora propios, grupos y Meta AI", () => {
    expect(aWebhookMeta({ ...texto, data: { ...texto.data, fromMe: true } }, PNID)).toBeNull();
    expect(aWebhookMeta({ ...texto, data: { ...texto.data, is_group: true } }, PNID)).toBeNull();
    expect(aWebhookMeta({ ...texto, data: { ...texto.data, isMetaAI: true } }, PNID)).toBeNull();
  });

  it("traduce una imagen con su enlace de D-API", () => {
    const body = aWebhookMeta(
      {
        ...texto,
        data: {
          ...texto.data,
          type: "image",
          message: "",
          media_url: "https://media.d-api.cloud/v1/tok.jpg",
          media_data: { mimetype: "image/jpeg", caption: "mi foto" },
        },
      },
      PNID,
    ) as { entry: Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }> };
    const msg = body.entry[0].changes[0].value.messages[0];
    expect(msg.type).toBe("image");
    const image = msg.image as { id: string; mime_type: string; caption: string };
    expect(image.mime_type).toBe("image/jpeg");
    expect(image.caption).toBe("mi foto");
    expect(leerMediaIdDapi(image.id)?.url).toBe("https://media.d-api.cloud/v1/tok.jpg");
  });

  it("traduce leído/entregado a statuses", () => {
    const body = aWebhookMeta(
      {
        event: "message.read",
        sessionId: "wacrm-abc123",
        data: {
          message_id: "M1",
          remote_jid: "5215512345678@s.whatsapp.net",
          timestamp: 1769295600000,
        },
      },
      PNID,
    ) as { entry: Array<{ changes: Array<{ value: { statuses: unknown[] } }> }> };
    expect(body.entry[0].changes[0].value.statuses).toEqual([
      { id: "M1", status: "read", timestamp: "1769295600", recipient_id: "5215512345678" },
    ]);
  });
});

describe("meta-api desvía las islas D-API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda texto por D-API con la API Key sin Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta({ messageId: "X9" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sendTextMessage({
      phoneNumberId: PNID,
      accessToken: "sk_clave",
      to: "+52 1 55 1234 5678",
      text: "hola",
    });
    expect(r).toEqual({ messageId: "X9" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.d-api.cloud/api/v1/messages/send/text");
    expect(init.headers.Authorization).toBe("sk_clave");
    expect(JSON.parse(init.body)).toEqual({
      sessionId: "wacrm-abc123",
      to: "5215512345678",
      text: "hola",
    });
  });

  it("manda audio como nota de voz", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta({ id: "A1" }));
    vi.stubGlobal("fetch", fetchMock);
    await sendMediaMessage({
      phoneNumberId: PNID,
      accessToken: "sk_clave",
      to: "5215512345678",
      kind: "audio",
      link: "https://x.test/a.ogg",
      caption: "no va",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.d-api.cloud/api/v1/messages/send/audio");
    expect(JSON.parse(init.body)).toEqual({
      sessionId: "wacrm-abc123",
      to: "5215512345678",
      audio: "https://x.test/a.ogg",
      ptt: true,
    });
  });

  it("convierte botones en texto numerado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta({ messageId: "B1" }));
    vi.stubGlobal("fetch", fetchMock);
    await sendInteractiveButtons({
      phoneNumberId: PNID,
      accessToken: "sk_clave",
      to: "5215512345678",
      bodyText: "¿Te lo mando?",
      buttons: [
        { id: "si", title: "Sí" },
        { id: "no", title: "No" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.d-api.cloud/api/v1/messages/send/text");
    expect(JSON.parse(init.body).text).toBe("¿Te lo mando?\n\n1. Sí\n2. No");
  });

  it("no manda plantillas por D-API", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      sendTemplateMessage({
        phoneNumberId: PNID,
        accessToken: "sk_clave",
        to: "5215512345678",
        templateName: "hola",
      } as Parameters<typeof sendTemplateMessage>[0]),
    ).rejects.toThrow(/D-API/);
  });

  it("reporta la isla sana sin llamar a Meta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getPhoneNumberHealth({ phoneNumberId: PNID, accessToken: "sk" }),
    ).resolves.toMatchObject({ status: "CONNECTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resuelve y baja la media sin mandar credenciales", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bytes", { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const mediaId = mediaIdDapi("https://media.d-api.cloud/v1/tok.jpg", "image/jpeg");
    const info = await getMediaUrl({ mediaId, accessToken: "sk" });
    expect(info.url).toBe("https://media.d-api.cloud/v1/tok.jpg");
    await downloadMedia({ downloadUrl: info.url, accessToken: "sk" });
    expect(fetchMock).toHaveBeenCalledWith("https://media.d-api.cloud/v1/tok.jpg", undefined);
  });
});
