import { describe, expect, it } from "vitest";

import { deriveCanvasEdges, outgoingSlots } from "./edges";
import { validateFlowForActivation } from "./validate";
import type { BuilderNode } from "@/components/flows/shared";

/**
 * Nodos nuevos: «Esperar» (temporizador) y «Guardar respuesta» (con
 * salida si contesta y si no). Lo que se prueba aquí es lo que el editor
 * y el validador prometen: las salidas que se ven en el lienzo y los
 * errores que deben saltar antes de activar.
 */

const arbol = (): BuilderNode[] => [
  { node_key: "inicio", node_type: "start", config: { next_node_key: "esperar" } },
  { node_key: "esperar", node_type: "wait", config: { segundos: 20, next_node_key: "guardar" } },
  {
    node_key: "guardar",
    node_type: "save_reply",
    config: {
      prompt_text: "¿Lo quieres?",
      var_key: "respuesta",
      espera_minutos: 30,
      contesto_next: "si",
      no_contesto_next: "no",
    },
  },
  { node_key: "si", node_type: "end", config: {} },
  { node_key: "no", node_type: "end", config: {} },
];

const flow = {
  name: "prueba",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["hola"], match_type: "contains" as const },
  entry_node_id: "inicio",
  fallback_policy: {},
};

describe("nodos esperar y guardar respuesta", () => {
  it("esperar tiene una salida y guardar respuesta dos", () => {
    const nodos = arbol();
    expect(outgoingSlots(nodos[1]).map((s) => s.id)).toEqual(["next"]);
    expect(outgoingSlots(nodos[2]).map((s) => s.id)).toEqual([
      "contesto",
      "no_contesto",
    ]);
  });

  it("el lienzo dibuja las dos flechas con su etiqueta", () => {
    const flechas = deriveCanvasEdges(arbol());
    const etiquetas = flechas
      .filter((e) => e.source === "guardar")
      .map((e) => e.label);
    expect(etiquetas).toEqual(["si contesta", "si no contesta"]);
  });

  it("un flujo bien armado no tiene errores", () => {
    const errores = validateFlowForActivation(flow, arbol()).filter(
      (i) => i.severity === "error",
    );
    expect(errores).toEqual([]);
  });

  it("avisa si la espera no tiene segundos válidos", () => {
    const nodos = arbol();
    nodos[1] = { ...nodos[1], config: { segundos: 0, next_node_key: "guardar" } };
    const campos = validateFlowForActivation(flow, nodos).map((i) => i.field);
    expect(campos).toContain("segundos");
  });

  it("avisa si guardar respuesta no tiene las dos salidas", () => {
    const nodos = arbol();
    nodos[2] = {
      ...nodos[2],
      config: {
        prompt_text: "",
        var_key: "respuesta",
        espera_minutos: 30,
        contesto_next: "si",
        no_contesto_next: "",
      },
    };
    const campos = validateFlowForActivation(flow, nodos).map((i) => i.field);
    expect(campos).toContain("no_contesto_next");
  });

  it("avisa si guardar respuesta no tiene variable", () => {
    const nodos = arbol();
    nodos[2] = {
      ...nodos[2],
      config: {
        prompt_text: "",
        var_key: "",
        espera_minutos: 30,
        contesto_next: "si",
        no_contesto_next: "no",
      },
    };
    const campos = validateFlowForActivation(flow, nodos).map((i) => i.field);
    expect(campos).toContain("var_key");
  });
});
