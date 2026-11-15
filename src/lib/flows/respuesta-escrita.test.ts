import { describe, it, expect } from "vitest";
import { matchTypedReply, numeroEscrito, rangoDeTitulo } from "./engine";

const lista = (rows: [string, string][]) => ({
  node_type: "send_list",
  config: { sections: [{ rows: rows.map(([title, next]) => ({ title, reply_id: next, next_node_key: next })) }] },
});
const botones = (bs: [string, string][]) => ({
  node_type: "send_buttons",
  config: { buttons: bs.map(([title, next]) => ({ title, reply_id: next, next_node_key: next })) },
});

const PESO = lista([["Menos de 60 kg", "p1"], ["De 60 a 74 kg", "p2"], ["De 75 a 89 kg", "p3"], ["90 kg o más", "p4"]]);
const EDAD = botones([["Menos de 40", "e39"], ["40 a 49", "e49"], ["50 o más", "e50"]]);
const CASO = botones([["😋 El hambre", "hambre"], ["🎈 La hinchazón", "hinch"], ["😩 Las dos", "ambas"]]);
const OFERTA = botones([["💚 Lo quiero", "quiero"], ["🤔 Tengo una duda", "duda"]]);
const UPSELL = botones([["✅ Agregar", "si"], ["No, gracias", "no"]]);
const EMPEZAR = botones([["✅ Sí, empecemos", "p1"]]);

describe("respuestas escritas a botones y listas", () => {
  it("rangos de los títulos", () => {
    expect(rangoDeTitulo("Menos de 60 kg")).toEqual([0, 59]);
    expect(rangoDeTitulo("De 60 a 74 kg")).toEqual([60, 74]);
    expect(rangoDeTitulo("90 kg o más")).toEqual([90, Infinity]);
    expect(rangoDeTitulo("Más de 20 kg")).toEqual([21, Infinity]);
  });
  it("lee el número correcto", () => {
    expect(numeroEscrito("87 kilos mido 1,67")).toBe(87);
    expect(numeroEscrito("mido 1.67 y peso 87kg")).toBe(87);
    expect(numeroEscrito("Buenos dias yo peso 78 y tengo 47 años", "kg")).toBe(78);
    expect(numeroEscrito("Buenos dias yo peso 78 y tengo 47 años", "anos")).toBe(47);
    expect(numeroEscrito("tengo 45 y peso 80 kilos", "anos")).toBe(45);
    expect(numeroEscrito("hola")).toBeNull();
  });
  it("peso escrito", () => {
    expect(matchTypedReply(PESO, "87 kilos mido 1,67")).toBe("p3");
    expect(matchTypedReply(PESO, "peso 58")).toBe("p1");
    expect(matchTypedReply(PESO, "100kg")).toBe("p4");
    expect(matchTypedReply(PESO, "no sé cuánto peso")).toBeNull();
    expect(matchTypedReply(PESO, "Buenos dias yo peso 78 y tengo 47 años")).toBe("p3");
    expect(matchTypedReply(EDAD, "Buenos dias yo peso 78 y tengo 47 años")).toBe("e49");
  });
  it("edad escrita", () => {
    expect(matchTypedReply(EDAD, "40")).toBe("e49");
    expect(matchTypedReply(EDAD, "tengo 52 años")).toBe("e50");
    expect(matchTypedReply(EDAD, "35")).toBe("e39");
  });
  it("opción por su texto", () => {
    expect(matchTypedReply(CASO, "Las dos cosas")).toBe("ambas");
    expect(matchTypedReply(CASO, "la hinchazon")).toBe("hinch");
    expect(matchTypedReply(CASO, "el hambre sobre todo")).toBe("hambre");
    expect(matchTypedReply(CASO, "sí")).toBeNull(); // ambiguo → contesta la IA
  });
  it("sí / no", () => {
    expect(matchTypedReply(EMPEZAR, "Ok")).toBe("p1");
    expect(matchTypedReply(EMPEZAR, "Sí claro")).toBe("p1");
    expect(matchTypedReply(OFERTA, "sí lo quiero")).toBe("quiero");
    expect(matchTypedReply(OFERTA, "¿y cuánto cuesta?")).toBeNull();
    expect(matchTypedReply(OFERTA, "quiero saber más de cómo funciona antes de comprar porfa")).toBeNull();
    expect(matchTypedReply(UPSELL, "no gracias")).toBe("no");
    expect(matchTypedReply(UPSELL, "sí agrégalo")).toBe("si");
  });
});
