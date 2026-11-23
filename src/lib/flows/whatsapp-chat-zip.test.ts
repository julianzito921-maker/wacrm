import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { ChatZipError, parseChatZipEntries } from "./whatsapp-chat-zip";

function descomprimir(entradas: Record<string, string | Uint8Array>) {
  const archivos: Record<string, Uint8Array> = {};
  for (const [ruta, valor] of Object.entries(entradas)) {
    archivos[ruta] = typeof valor === "string" ? strToU8(valor) : valor;
  }
  return unzipSync(zipSync(archivos));
}

const CHAT = [
  "01/02/24, 10:00 - Ana: Hola",
  "01/02/24, 10:00:20 - Negocio: IMG-1.jpg (archivo adjunto) Mira",
  "01/02/24, 10:01 - Ana: Vale",
].join("\n");

describe("parseChatZipEntries", () => {
  it("elige el .txt, arma los medios y clasifica el chat", () => {
    const entradas = descomprimir({
      "WhatsApp Chat with Ana/_chat.txt": CHAT,
      "WhatsApp Chat with Ana/IMG-1.jpg": new Uint8Array([1, 2, 3, 4]),
      "__MACOSX/WhatsApp Chat with Ana/._IMG-1.jpg": new Uint8Array([9]),
      "WhatsApp Chat with Ana/.DS_Store": new Uint8Array([0]),
    });
    const leido = parseChatZipEntries(entradas);
    expect(leido.nombreTxt).toContain("_chat.txt");
    expect(leido.chat.messages).toHaveLength(3);
    expect(leido.variosTxt).toBe(false);
    expect([...leido.medios.keys()]).toEqual(["img-1.jpg"]);
    expect(leido.medios.get("img-1.jpg")).toMatchObject({
      nombre: "IMG-1.jpg",
      size: 4,
    });
  });

  it("usa el .txt más grande si hay varios y lo avisa", () => {
    const entradas = descomprimir({
      "a/_chat.txt": "01/02/24, 10:00 - Ana: Hola",
      "b/_chat.txt": CHAT,
    });
    const leido = parseChatZipEntries(entradas);
    expect(leido.variosTxt).toBe(true);
    expect(leido.chat.messages).toHaveLength(3);
  });

  it("rechaza zips sin .txt", () => {
    const entradas = descomprimir({ "IMG-1.jpg": new Uint8Array([1]) });
    expect(() => parseChatZipEntries(entradas)).toThrow(ChatZipError);
    try {
      parseChatZipEntries(entradas);
    } catch (err) {
      expect((err as ChatZipError).code).toBe("no_txt");
    }
  });

  it("rechaza chats de grupo y de un solo lado", () => {
    const grupo = descomprimir({
      "_chat.txt": [
        "01/02/24, 10:00 - Ana: Hola",
        "01/02/24, 10:00:10 - Luis: Hola",
        "01/02/24, 10:00:20 - Negocio: Hola",
      ].join("\n"),
    });
    try {
      parseChatZipEntries(grupo);
    } catch (err) {
      expect((err as ChatZipError).code).toBe("group_chat");
    }

    const unLado = descomprimir({
      "_chat.txt": "01/02/24, 10:00 - Ana: Hola",
    });
    try {
      parseChatZipEntries(unLado);
    } catch (err) {
      expect((err as ChatZipError).code).toBe("one_sided");
    }
  });

  it("rechaza un .txt sin mensajes reconocibles", () => {
    const entradas = descomprimir({
      "_chat.txt": "Los mensajes y las llamadas están cifrados de extremo a extremo.",
    });
    try {
      parseChatZipEntries(entradas);
    } catch (err) {
      expect((err as ChatZipError).code).toBe("no_messages");
    }
  });
});
