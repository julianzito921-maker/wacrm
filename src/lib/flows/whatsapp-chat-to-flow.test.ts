import { describe, expect, it } from "vitest";
import { parseWhatsAppChat } from "./whatsapp-chat-parser";
import {
  buildChatFlow,
  tieneIncidenciasBloqueantes,
} from "./whatsapp-chat-to-flow";
import { validateFlowForActivation } from "./validate";

const urls = (...pares: Array<[string, string]>) =>
  new Map(pares.map(([k, v]) => [k.toLowerCase(), v]));

const medios = urls(
  ["IMG-1.jpg", "https://x/1.jpg"],
  ["IMG-2.jpg", "https://x/2.jpg"],
  ["PTT-1.opus", "https://x/1.opus"],
  ["STK-1.webp", "https://x/1.webp"],
);

function construir(lineas: string[], opciones: { trigger?: "keyword" | "any_message"; mediaUrls?: Map<string, string> } = {}) {
  const chat = parseWhatsAppChat(lineas.join("\n"));
  return buildChatFlow({
    chat,
    businessName: "Negocio",
    mediaUrls: opciones.mediaUrls ?? new Map(),
    trigger: opciones.trigger,
  });
}

const itemsDe = (flow: ReturnType<typeof construir>, key: string) =>
  (flow.nodes.find((n) => n.node_key === key)?.config.items ?? []) as Array<
    Record<string, unknown>
  >;

describe("buildChatFlow — secuencia y tiempos", () => {
  it("crea espera de reacción, bloque, espera de respuesta y bloque, en orden", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "01/02/24, 10:00:20 - Negocio: Bienvenida",
      "01/02/24, 10:00:24 - Negocio: Mira",
      "01/02/24, 10:02 - Ana: Cuánto cuesta",
      "01/02/24, 10:02:10 - Negocio: Cuesta 10",
    ]);
    expect(flow.nodes.map((n) => n.node_key)).toEqual([
      "start",
      "pausa_1",
      "msg_1",
      "espera_1",
      "pausa_2",
      "msg_2",
      "fin",
    ]);
    expect(flow.trigger_type).toBe("keyword");
    expect(flow.trigger_config).toMatchObject({ keywords: ["Hola"] });
    expect(flow.nodes[1].config.segundos).toBe(20);
    expect(flow.nodes[2].config.next_node_key).toBe("espera_1");
    expect(flow.nodes[3].config.contesto_next).toBe("pausa_2");
    expect(flow.nodes[3].config.no_contesto_next).toBe("fin");
    expect(flow.nodes[4].config.segundos).toBe(10);
    const items = itemsDe(flow, "msg_1");
    expect(items.map((i) => i.tipo)).toEqual(["text", "text"]);
    expect(items[0].segundos).toBe(0);
    expect(items[1].segundos).toBe(4);
    expect(flow.stats).toMatchObject({ turnosCliente: 1, bloques: 2, esperas: 2 });
  });

  it("respeta el orden exacto de burbujas y el pie de foto", () => {
    const flow = construir(
      [
        "01/02/24, 10:00 - Ana: Hola",
        "01/02/24, 10:00:30 - Negocio: IMG-1.jpg (archivo adjunto) Foto 1",
        "01/02/24, 10:00:31 - Negocio: IMG-2.jpg (archivo adjunto) Foto 2",
        "01/02/24, 10:00:32 - Negocio: Texto",
        "01/02/24, 10:00:33 - Negocio: PTT-1.opus (archivo adjunto)",
        "01/02/24, 10:00:34 - Negocio: STK-1.webp (archivo adjunto)",
      ],
      { mediaUrls: medios },
    );
    const items = itemsDe(flow, "msg_1");
    expect(items.map((i) => i.tipo)).toEqual([
      "image",
      "image",
      "text",
      "audio",
      "sticker",
    ]);
    expect(items[0]).toMatchObject({ text: "Foto 1", media_url: "https://x/1.jpg" });
    expect(items[3].media_url).toBe("https://x/1.opus");
    expect(items[4].media_url).toBe("https://x/1.webp");
    expect(flow.stats.medios).toBe(4);
  });

  it("usa una burbuja interval cuando el hueco dentro de la ráfaga pasa de 60 s", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "01/02/24, 10:00:10 - Negocio: Uno",
      "01/02/24, 10:05:10 - Negocio: Dos",
    ]);
    const items = itemsDe(flow, "msg_1");
    expect(items.map((i) => i.tipo)).toEqual(["text", "interval", "text"]);
    expect(items[1].segundos).toBe(300);
  });

  it("parte en dos bloques con wait cuando la ráfaga pasa de 30 min", () => {
    const flow = construir([
      "01/02/24, 09:59:50 - Ana: Hola",
      "01/02/24, 10:00 - Negocio: Uno",
      "01/02/24, 10:40 - Negocio: Dos",
    ]);
    expect(flow.nodes.map((n) => n.node_key)).toEqual([
      "start",
      "pausa_1",
      "msg_1",
      "pausa_2",
      "msg_2",
      "fin",
    ]);
    expect(flow.nodes[3].config.segundos).toBe(2400);
    expect(flow.stats.bloques).toBe(2);
  });

  it("capa a 23 h las esperas mayores y lo reporta", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "03/02/24, 10:00 - Negocio: Tarde",
    ]);
    const pausa = flow.nodes.find((n) => n.node_key === "pausa_1");
    expect(pausa?.config.segundos).toBe(23 * 3600);
    expect(flow.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "delay_capped", blocking: false }),
      ]),
    );
  });
});

describe("buildChatFlow — incidencias", () => {
  it("bloquea si falta un medio y conserva el texto como respaldo", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "01/02/24, 10:00:30 - Negocio: IMG-1.jpg (archivo adjunto) Hola",
    ]);
    expect(flow.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "media_missing",
          blocking: true,
          detail: "IMG-1.jpg",
        }),
      ]),
    );
    expect(tieneIncidenciasBloqueantes(flow.issues)).toBe(true);
    expect(itemsDe(flow, "msg_1")).toEqual([
      expect.objectContaining({ tipo: "text", text: "Hola" }),
    ]);
  });

  it("reporta medios omitidos y mensajes no soportados, sin inventarlos", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "01/02/24, 10:00:30 - Negocio: imagen omitida",
      "01/02/24, 10:00:31 - Negocio: Este mensaje fue eliminado",
      "01/02/24, 10:00:32 - Negocio: Hola de verdad",
    ]);
    expect(flow.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "omitted_media", blocking: true }),
        expect.objectContaining({ code: "unsupported_message", blocking: true, detail: "eliminado" }),
      ]),
    );
    const items = itemsDe(flow, "msg_1");
    expect(items).toEqual([expect.objectContaining({ tipo: "text", text: "Hola de verdad" })]);
  });

  it("avisa si el negocio habló antes que el cliente, sin bloquear", () => {
    const flow = construir([
      "01/02/24, 10:00 - Negocio: Hola",
      "01/02/24, 10:00:10 - Ana: Hola",
      "01/02/24, 10:00:20 - Negocio: Qué tal",
    ]);
    expect(flow.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "business_first", blocking: false }),
      ]),
    );
  });
});

describe("buildChatFlow — disparador y cierre", () => {
  it("usa any_message si el primer mensaje del cliente es un medio", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: IMG-0.jpg (archivo adjunto)",
      "01/02/24, 10:00:10 - Negocio: Hola",
    ]);
    expect(flow.trigger_type).toBe("any_message");
    expect(flow.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "first_message_media", blocking: false }),
      ]),
    );
  });

  it("cierra con fin y deja las posiciones alineadas", () => {
    const flow = construir([
      "01/02/24, 10:00 - Ana: Hola",
      "01/02/24, 10:00:10 - Negocio: Uno",
      "01/02/24, 10:01 - Ana: Dos",
      "01/02/24, 10:01:10 - Negocio: Tres",
    ]);
    const fin = flow.nodes.find((n) => n.node_key === "fin");
    expect(fin?.node_type).toBe("end");
    expect(flow.nodes[flow.nodes.length - 1]?.node_key).toBe("fin");
    flow.nodes.forEach((n, i) => {
      expect(n.position_x).toBe(0);
      expect(n.position_y).toBe(i * 170);
    });
    const ultimo = flow.nodes[flow.nodes.length - 2];
    if (ultimo?.node_type === "save_reply") {
      expect(ultimo.config.contesto_next).toBe("fin");
      expect(ultimo.config.no_contesto_next).toBe("fin");
    } else {
      expect(ultimo?.config.next_node_key).toBe("fin");
    }
  });
});

describe("buildChatFlow — flujo activable", () => {
  it("pasa la validación de activación con medios, esperas y fin", () => {
    const chat = parseWhatsAppChat(
      [
        "01/02/24, 10:00 - Ana: Hola",
        "01/02/24, 10:00:30 - Negocio: IMG-1.jpg (archivo adjunto) Foto",
        "01/02/24, 10:00:34 - Negocio: PTT-1.opus (archivo adjunto)",
        "01/02/24, 10:02 - Ana: Cuanto cuesta",
        "03/02/24, 09:00 - Negocio: STK-1.webp (archivo adjunto)",
      ].join("\n"),
    );
    const flow = buildChatFlow({
      chat,
      businessName: "Negocio",
      mediaUrls: medios,
    });
    const errores = validateFlowForActivation(
      {
        name: "Chat de prueba",
        trigger_type: flow.trigger_type,
        trigger_config: flow.trigger_config,
        entry_node_id: "start",
      },
      flow.nodes,
    ).filter((i) => i.severity === "error");
    expect(errores).toEqual([]);
  });
});
