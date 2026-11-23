import { describe, expect, it } from "vitest";
import { parseWhatsAppChat } from "./whatsapp-chat-parser";

const LINEAS = (...ls: string[]) => ls.join("\n");

describe("parseWhatsAppChat — formatos", () => {
  it("lee el formato Android con corchetes, segundos y p. m.", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "[31/12/24, 9:41:05 p. m.] Ana: Hola",
        "[31/12/24, 9:42:10 p. m.] Negocio: IMG-20241231-WA0001.jpg (archivo adjunto)",
        "Mira esto",
        "[31/12/24, 9:42:11 p. m.] Negocio: *Oferta*",
      ),
    );
    expect(chat.format).toBe("android");
    expect(chat.participants).toEqual([
      { name: "Negocio", count: 2 },
      { name: "Ana", count: 1 },
    ]);
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[1].media).toEqual({
      filename: "IMG-20241231-WA0001.jpg",
      kind: "image",
    });
    expect(chat.messages[1].text).toBe("Mira esto");
    expect(chat.messages[0].at.getHours()).toBe(21);
    expect(chat.messages[2].text).toBe("*Oferta*");
  });

  it("lee el formato iOS con guion y AM/PM", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "12/31/24, 9:41 PM - Ana: Hola",
        "12/31/24, 9:42 PM - Negocio: <attached: STK-20241231-WA0002.webp>",
      ),
    );
    expect(chat.format).toBe("ios");
    expect(chat.messages[1].media?.kind).toBe("sticker");
    expect(chat.messages[0].at.getMonth()).toBe(11);
    expect(chat.messages[0].at.getDate()).toBe(31);
  });

  it("detecta día primero cuando algún día pasa de 12", () => {
    const chat = parseWhatsAppChat("31/12/24, 21:41 - Ana: Hola");
    expect(chat.messages[0].at.getMonth()).toBe(11);
    expect(chat.messages[0].at.getDate()).toBe(31);
  });

  it("con fechas ambiguas usa la preferencia del idioma", () => {
    const dmy = parseWhatsAppChat("05/06/24, 10:00 - Ana: Hola");
    expect(dmy.messages[0].at.getMonth()).toBe(5); // junio (día 5)
    expect(dmy.messages[0].at.getDate()).toBe(5);
    expect(dmy.issues.some((i) => i.code === "ambiguous_dates")).toBe(true);

    const mdy = parseWhatsAppChat("05/06/24, 10:00 - Ana: Hola", {
      preferDayFirst: false,
    });
    expect(mdy.messages[0].at.getMonth()).toBe(4); // mayo (día 5)
    expect(mdy.messages[0].at.getDate()).toBe(6);
  });

  it("acepta año primero (formato coreano)", () => {
    const chat = parseWhatsAppChat("2024. 12. 31. 21:41 - Ana: Hola");
    expect(chat.messages[0].at.getFullYear()).toBe(2024);
    expect(chat.messages[0].at.getMonth()).toBe(11);
  });

  it("convierte 12 AM/PM correctamente", () => {
    const am = parseWhatsAppChat("01/02/24, 12:05 AM - Ana: a");
    const pm = parseWhatsAppChat("01/02/24, 12:05 PM - Ana: b");
    expect(am.messages[0].at.getHours()).toBe(0);
    expect(pm.messages[0].at.getHours()).toBe(12);
  });
});

describe("parseWhatsAppChat — medios", () => {
  it("separa el pie de foto de la misma línea y de las siguientes", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "01/02/24, 10:00 - Negocio: VID-1.mp4 (archivo adjunto) Video nuevo",
        "linea 2",
      ),
    );
    expect(chat.messages[0].media?.kind).toBe("video");
    expect(chat.messages[0].text).toBe("Video nuevo\nlinea 2");
  });

  it("reconoce notas de voz, documentos y angulares de iOS", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "01/02/24, 10:00 - Negocio: PTT-20240201-WA0001.opus (archivo adjunto)",
        "01/02/24, 10:01 - Negocio: <attached: presupuesto.pdf>",
        "01/02/24, 10:02 - Negocio: <IMG_0003.JPG>",
      ),
    );
    expect(chat.messages[0].media?.kind).toBe("audio");
    expect(chat.messages[1].media?.kind).toBe("document");
    expect(chat.messages[2].media?.kind).toBe("image");
  });

  it("marca los medios omitidos sin inventar archivo", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "01/02/24, 10:00 - Ana: imagen omitida",
        "01/02/24, 10:01 - Ana: <Media omitted>",
      ),
    );
    expect(chat.messages[0].media).toBeNull();
    expect(chat.messages[0].omitted).toBe(true);
    expect(chat.messages[1].omitted).toBe(true);
  });

  it("marca tipos no clonables (eliminado, ver una vez, ubicación)", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "01/02/24, 10:00 - Ana: Este mensaje fue eliminado",
        "01/02/24, 10:01 - Ana: Ver una vez",
        "01/02/24, 10:02 - Ana: Ubicación omitida",
      ),
    );
    expect(chat.messages[0].unsupported).toBe("eliminado");
    expect(chat.messages[1].unsupported).toBe("ver_una_vez");
    expect(chat.messages[2].unsupported).toBe("ubicacion");
  });
});

describe("parseWhatsAppChat — texto y sistema", () => {
  it("anexa las líneas de continuación al mensaje anterior", () => {
    const chat = parseWhatsAppChat(
      LINEAS("01/02/24, 10:00 - Ana: Mira:", "esto es una prueba", "y otra línea"),
    );
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe("Mira:\nesto es una prueba\ny otra línea");
  });

  it("ignora líneas de sistema y separadores de fecha", () => {
    const chat = parseWhatsAppChat(
      LINEAS(
        "Los mensajes y las llamadas están cifrados de extremo a extremo.",
        "01/02/24, 10:00 - Ana: Hola",
        "01/02/24",
        "01/02/24, 10:01 - Ana cambió el asunto a \"Promo\"",
      ),
    );
    expect(chat.messages).toHaveLength(1);
    expect(chat.participants).toEqual([{ name: "Ana", count: 1 }]);
  });

  it("limpia BOM y marcas invisibles al inicio de los medios", () => {
    const chat = parseWhatsAppChat(
      `\ufeff\u200e01/02/24, 10:00 - Negocio: \u200eIMG-9.jpg (archivo adjunto)`,
    );
    expect(chat.messages[0].media?.filename).toBe("IMG-9.jpg");
    expect(chat.messages[0].text).toBe("");
  });

  it("devuelve no_messages si el archivo no tiene mensajes", () => {
    const chat = parseWhatsAppChat("Los mensajes y las llamadas están cifrados.");
    expect(chat.messages).toHaveLength(0);
    expect(chat.issues.some((i) => i.code === "no_messages")).toBe(true);
  });
});
