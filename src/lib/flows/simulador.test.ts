import { describe, expect, it } from "vitest";

import {
  accion,
  accionesDisponibles,
  arrancar,
  disparaElFlujo,
  estadoInicial,
  recibir,
  type SimFlujo,
  type SimNodo,
  type SimSalida,
} from "./simulador";

function flujo(nodes: SimNodo[], extra: Partial<SimFlujo> = {}): SimFlujo {
  return {
    id: "f1",
    trigger_type: "keyword",
    trigger_config: { keywords: ["chia"], match_type: "contains" },
    entry_node_id: "start",
    fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 1, on_exhaust: "handoff" },
    nodes,
    ...extra,
  };
}

const textos = (s: SimSalida[]) =>
  s.flatMap((x) => (x.tipo === "texto" || x.tipo === "botones" ? [x.texto] : []));
const codigos = (s: SimSalida[]) => s.flatMap((x) => (x.tipo === "evento" ? [x.codigo] : []));

const embudo = flujo([
  { node_key: "start", node_type: "start", config: { next_node_key: "hola" } },
  { node_key: "hola", node_type: "send_message", config: { text: "Hola 👋", next_node_key: "pregunta" } },
  {
    node_key: "pregunta",
    node_type: "send_buttons",
    config: {
      text: "¿Lo quieres?",
      buttons: [
        { reply_id: "si", title: "Sí, lo quiero", next_node_key: "nombre" },
        { reply_id: "no", title: "No, gracias", next_node_key: "fin" },
      ],
    },
  },
  {
    node_key: "nombre",
    node_type: "save_reply",
    config: {
      prompt_text: "¿Cómo te llamas?",
      var_key: "nombre",
      contesto_next: "saludo",
      no_contesto_next: "recordatorio",
      espera_segundos: 3600,
    },
  },
  { node_key: "saludo", node_type: "send_message", config: { text: "Gracias {{vars.nombre}}", next_node_key: "" } },
  { node_key: "recordatorio", node_type: "send_message", config: { text: "¿Sigues ahí?", next_node_key: "" } },
  { node_key: "fin", node_type: "end", config: {} },
]);

describe("simulador del embudo", () => {
  it("arranca solo con la palabra clave del disparador", async () => {
    const e0 = estadoInicial("f1");
    const no = await recibir(e0, embudo, { kind: "text", text: "hola" });
    expect(no.consumido).toBe(false);
    expect(codigos(no.salidas)).toContain("no_dispara");

    const si = await recibir(no.estado, embudo, { kind: "text", text: "info de la chia" });
    expect(si.consumido).toBe(true);
    expect(textos(si.salidas)).toEqual(["Hola 👋", "¿Lo quieres?"]);
    expect(si.estado.actual).toBe("pregunta");
  });

  it("avanza con el toque del botón y con la respuesta escrita", async () => {
    const r0 = await arrancar(estadoInicial("f1"), embudo);
    const toque = await recibir(r0.estado, embudo, { kind: "tap", reply_id: "si", title: "Sí, lo quiero" });
    expect(textos(toque.salidas)).toEqual(["¿Cómo te llamas?"]);

    const escrito = await recibir(r0.estado, embudo, { kind: "text", text: "sí" });
    expect(escrito.estado.actual).toBe("nombre");
  });

  it("guarda la respuesta en la variable y la usa en el siguiente mensaje", async () => {
    const r0 = await arrancar(estadoInicial("f1"), embudo);
    const r1 = await recibir(r0.estado, embudo, { kind: "tap", reply_id: "si", title: "Sí" });
    const r2 = await recibir(r1.estado, embudo, { kind: "text", text: "Ana" });
    expect(r2.estado.vars.nombre).toBe("Ana");
    expect(textos(r2.salidas)).toEqual(["Gracias Ana"]);
    expect(r2.estado.fase).toBe("terminada");
    expect(codigos(r2.salidas)).toContain("fin_de_rama");
  });

  it("«No contesta» sigue por su salida sin esperar la hora", async () => {
    const r0 = await arrancar(estadoInicial("f1"), embudo);
    const r1 = await recibir(r0.estado, embudo, { kind: "tap", reply_id: "si", title: "Sí" });
    expect(accionesDisponibles(r1.estado, embudo)).toEqual(["no_contesta"]);
    const r2 = await accion(r1.estado, embudo, "no_contesta");
    expect(textos(r2.salidas)).toEqual(["¿Sigues ahí?"]);
  });

  it("repregunta y, al agotar los intentos, pasa a una persona", async () => {
    const r0 = await arrancar(estadoInicial("f1"), embudo);
    const r1 = await recibir(r0.estado, embudo, { kind: "text", text: "cuánto cuesta?" });
    expect(codigos(r1.salidas)).toContain("fallback_repregunta");
    expect(textos(r1.salidas)).toEqual(["¿Lo quieres?"]);
    const r2 = await recibir(r1.estado, embudo, { kind: "text", text: "y el envío?" });
    expect(codigos(r2.salidas)).toContain("fallback_agotado_humano");
    expect(r2.estado.fin?.estado).toBe("handed_off");
  });

  it("con fallback «ignorar» el mensaje queda para la IA", async () => {
    const f = { ...embudo, fallback_policy: { on_unknown_reply: "ignore" } };
    const r0 = await arrancar(estadoInicial("f1"), f);
    const r1 = await recibir(r0.estado, f, { kind: "text", text: "precio?" });
    expect(r1.consumido).toBe(false);
    expect(r1.estado.fase).toBe("activa");
  });

  it("estaciona el Smart Delay largo y lo adelanta", async () => {
    const f = flujo([
      { node_key: "start", node_type: "start", config: { next_node_key: "espera" } },
      { node_key: "espera", node_type: "wait", config: { segundos: 7200, next_node_key: "m" } },
      { node_key: "m", node_type: "send_message", config: { text: "Ya pasó", next_node_key: "" } },
    ]);
    const r0 = await arrancar(estadoInicial("f1"), f);
    expect(r0.estado.espera?.tipo).toBe("tiempo");
    const mientras = await recibir(r0.estado, f, { kind: "text", text: "hola?" });
    expect(codigos(mientras.salidas)).toContain("mensaje_en_espera");
    const r1 = await accion(r0.estado, f, "adelantar");
    expect(textos(r1.salidas)).toEqual(["Ya pasó"]);
  });

  it("evalúa condiciones sobre variables y etiquetas puestas en la prueba", async () => {
    const f = flujo([
      { node_key: "start", node_type: "start", config: { next_node_key: "tag" } },
      { node_key: "tag", node_type: "set_tag", config: { mode: "add", tag_id: "t1", next_node_key: "c" } },
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "tag", subject_key: "t1", operator: "present", true_next: "a", false_next: "b" },
      },
      { node_key: "a", node_type: "send_message", config: { text: "con etiqueta", next_node_key: "" } },
      { node_key: "b", node_type: "send_message", config: { text: "sin etiqueta", next_node_key: "" } },
    ]);
    const r = await arrancar(estadoInicial("f1"), f);
    expect(textos(r.salidas)).toEqual(["con etiqueta"]);
    expect(r.salidas.some((s) => s.tipo === "efecto" && s.node_type === "set_tag")).toBe(true);
  });

  it("el bloque de IA rutea con la salida que da el servicio", async () => {
    const f = flujo([
      { node_key: "start", node_type: "start", config: { next_node_key: "ia" } },
      {
        node_key: "ia",
        node_type: "ai_block",
        config: {
          auto_send: true,
          conditions: [{ id: "compra", label: "Quiere comprar", next_node_key: "pago" }],
          fallback_next: "dudas",
        },
      },
      { node_key: "pago", node_type: "send_message", config: { text: "Te paso el pago", next_node_key: "" } },
      { node_key: "dudas", node_type: "send_message", config: { text: "¿Qué duda tienes?", next_node_key: "" } },
    ]);
    const r = await arrancar(estadoInicial("f1"), f, {
      iaBloque: async () => ({ respuesta: "¡Claro!", salida: "compra" }),
    });
    expect(textos(r.salidas)).toEqual(["¡Claro!", "Te paso el pago"]);

    const sinIa = await arrancar(estadoInicial("f1"), f);
    expect(textos(sinIa.salidas)).toEqual(["¿Qué duda tienes?"]);
  });

  it("Botón Pago: el comprobante válido va por aprobado y pone la etiqueta", async () => {
    const f = flujo([
      { node_key: "start", node_type: "start", config: { next_node_key: "spei" } },
      {
        node_key: "spei",
        node_type: "send_payment",
        config: {
          clabe: "012345678901234567",
          monto: 99,
          con_boton: false,
          espera_minutos: 60,
          aprobado_next: "ok",
          rechazado_next: "mal",
        },
      },
      { node_key: "ok", node_type: "send_message", config: { text: "¡Pago recibido!", next_node_key: "" } },
      { node_key: "mal", node_type: "send_message", config: { text: "No pudimos validarlo", next_node_key: "" } },
    ]);
    const r0 = await arrancar(estadoInicial("f1"), f);
    expect(textos(r0.salidas)[0]).toContain("012345678901234567");
    const otra = await recibir(r0.estado, f, { kind: "media", media_type: "image", caption: "", comprobante: "no" });
    expect(otra.estado.espera?.tipo).toBe("comprobante");
    const ok = await recibir(r0.estado, f, { kind: "media", media_type: "image", caption: "", comprobante: "valido" });
    expect(textos(ok.salidas)).toEqual(["¡Pago recibido!"]);
    expect(ok.estado.etiquetas).toContain("pagado");
    const vence = await accion(r0.estado, f, "no_contesta");
    expect(textos(vence.salidas)).toEqual(["No pudimos validarlo"]);
  });

  it("los disparadores «primer mensaje» y «cualquier mensaje» no se repiten", () => {
    const e = estadoInicial("f1");
    const entrada = { kind: "text" as const, text: "hola" };
    expect(disparaElFlujo({ trigger_type: "first_inbound_message", trigger_config: {} }, e, entrada)).toBe(true);
    expect(
      disparaElFlujo({ trigger_type: "first_inbound_message", trigger_config: {} }, { ...e, yaEscribio: true }, entrada),
    ).toBe(false);
    expect(disparaElFlujo({ trigger_type: "any_message", trigger_config: {} }, { ...e, yaCorrio: true }, entrada)).toBe(false);
    expect(disparaElFlujo({ trigger_type: "manual", trigger_config: {} }, e, entrada)).toBe(false);
  });

  it("el mensaje compuesto respeta el orden y estaciona intervalos largos", async () => {
    const f = flujo([
      { node_key: "start", node_type: "start", config: { next_node_key: "m" } },
      {
        node_key: "m",
        node_type: "send_message",
        config: {
          items: [
            { tipo: "text", text: "uno", segundos: 1 },
            { tipo: "interval", segundos: 600 },
            { tipo: "text", text: "dos", segundos: 1 },
          ],
          next_node_key: "",
        },
      },
    ]);
    const r0 = await arrancar(estadoInicial("f1"), f);
    expect(textos(r0.salidas)).toEqual(["uno"]);
    const r1 = await accion(r0.estado, f, "adelantar");
    expect(textos(r1.salidas)).toEqual(["dos"]);
    expect(r1.estado.fase).toBe("terminada");
  });
});
