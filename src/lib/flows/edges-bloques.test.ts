import { describe, expect, it } from "vitest";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";

type N = { node_key: string; node_type: never; config: Record<string, unknown> };
const n = (node_key: string, node_type: string, config: Record<string, unknown> = {}): N => ({
  node_key,
  node_type: node_type as never,
  config,
});

const NODOS = [
  n("ia", "ai_block", {
    conditions: [{ id: "si", label: "Quiere", next_node_key: "a" }],
    identify_receipt: true,
    receipt_next: "b",
    fallback_next: "c",
  }),
  n("dist", "distributor", { outputs: [{ id: "o1", label: "A", next_node_key: "a" }, { id: "o2", label: "B", next_node_key: "b" }] }),
  n("aviso", "notification", { next_node_key: "a" }),
  n("venta", "sale_approved", { next_node_key: "b" }),
  n("mani", "manipulator", { next_node_key: "c" }),
  n("car", "carousel", { cards: [{ id: "k1", buttons: [{ id: "b1", label: "Ver", type: "reply", next_node_key: "a" }] }], timeout_next: "c" }),
  n("a", "end"),
  n("b", "end"),
  n("c", "end"),
];

describe("líneas de los bloques que antes no se dibujaban", () => {
  it("dibuja todas sus salidas", () => {
    const l = deriveCanvasEdges(NODOS).map((e) => `${e.source}:${e.sourceHandle}>${e.target}`);
    expect(l).toEqual(
      expect.arrayContaining([
        "ia:cond:si>a",
        "ia:receipt>b",
        "ia:fallback>c",
        "dist:out:o1>a",
        "dist:out:o2>b",
        "aviso:next>a",
        "venta:next>b",
        "mani:next>c",
        "car:car_k1_b1>a",
        "car:timeout>c",
      ]),
    );
  });

  it("tienen puntos de conexión", () => {
    expect(outgoingSlots(NODOS[2]).map((s) => s.id)).toEqual(["next"]);
    expect(outgoingSlots(NODOS[1]).map((s) => s.id)).toEqual(["out:o1", "out:o2"]);
    expect(outgoingSlots(NODOS[5]).map((s) => s.id)).toEqual(["car_k1_b1", "timeout"]);
  });

  it("se pueden conectar desde el lienzo", () => {
    expect(applyEdgeConnection(NODOS[3], "next", "c")).toEqual({ next_node_key: "c" });
    expect(applyEdgeConnection(NODOS[4], "next", "a")).toEqual({ next_node_key: "a" });
  });

  it("al borrar un bloque se sueltan sus referencias", () => {
    const sin = unlinkNodeReferences(NODOS, "a");
    const ia = sin.find((x) => x.node_key === "ia")!.config as { conditions: Array<{ next_node_key: string }> };
    expect(ia.conditions[0].next_node_key).toBe("");
    const dist = sin.find((x) => x.node_key === "dist")!.config as { outputs: Array<{ next_node_key: string }> };
    expect(dist.outputs.map((o) => o.next_node_key)).toEqual(["", "b"]);
    expect(sin.find((x) => x.node_key === "aviso")!.config.next_node_key).toBe("");
  });
});
