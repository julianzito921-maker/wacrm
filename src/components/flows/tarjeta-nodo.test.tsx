import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { ReactFlowProvider } from "@xyflow/react";

import es from "../../../messages/es.json";
import { defaultConfigFor } from "./flow-editor-state";
import { CATALOGO_BLOQUES, type BuilderNode, type NodeType } from "./shared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("./flow-editor-state", async (orig) => {
  const real = await orig<typeof import("./flow-editor-state")>();
  return {
    ...real,
    useFlowEditor: () => ({ removeNode: () => {}, duplicateNode: () => {} }),
  };
});

import { TarjetaNodo } from "./tarjeta-nodo";

function dibujar(tipo: NodeType): string {
  const node: BuilderNode = {
    node_key: `${tipo}_1`,
    node_type: tipo,
    config: defaultConfigFor(tipo),
  };
  const errores: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="es"
      timeZone="America/Mexico_City"
      messages={es}
      onError={(e) => errores.push(e.message)}
    >
      <ReactFlowProvider>
        <TarjetaNodo
          data={{ node, isEntry: false, isFlashed: false, stats: { entradas: 10, avances: 4 } }}
        />
      </ReactFlowProvider>
    </NextIntlClientProvider>,
  );
  if (errores.length) throw new Error(`${tipo}: ${errores.join(" | ")}`);
  return html;
}

const TIPOS = [
  "start",
  ...new Set(CATALOGO_BLOQUES.map((b) => b.tipo).filter(Boolean) as NodeType[]),
] as NodeType[];

describe("tarjeta de bloque estilo Leona", () => {
  it.each(TIPOS)("%s se dibuja con su nombre y sin textos faltantes", (tipo) => {
    const html = dibujar(tipo);
    const nombre = (es.Flows.builder.nodes as Record<string, { label: string }>)[tipo]?.label;
    expect(nombre).toBeTruthy();
    expect(html).toContain(nombre.replace(/&/g, "&amp;"));
    expect(html).not.toContain("Flows.");
  });

  it("muestra las métricas Entradas · Avances · Tasa", () => {
    const html = dibujar("send_message");
    expect(html).toContain("40%");
    expect(html).toContain(">10<");
  });

  it("el Condicional trae su salida de «no se cumple»", () => {
    expect(dibujar("condition")).toContain(es.Flows.builder.conditionFallback);
  });

  it("la Venta aprobada es el círculo compacto de 90 px", () => {
    expect(dibujar("sale_approved")).toContain("rounded-full");
  });

  it("la paleta tiene el orden de Leona", () => {
    expect(CATALOGO_BLOQUES.slice(0, 4).map((b) => b.id)).toEqual([
      "mensaje",
      "template",
      "etiquetas",
      "pago",
    ]);
  });
});
