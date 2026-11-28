import { describe, expect, it } from "vitest";
import {
  convertirFlujoLeona,
  convertirVariables,
  esFlujoLeona,
  etiquetasDelFlujo,
  type LeonaFlujo,
} from "./convertir";
import { deriveCanvasEdges } from "@/lib/flows/edges";

/** Misma forma que el `get_flow` real de Leona (datos inventados). */
const LEONA: LeonaFlujo = {
  flow: { name: "Embudo de prueba", description: "demo", start_node: { id: 1 } },
  nodes: [
    { id: 1, node_type: "start", position: { x: -100, y: 50 }, actions: [] },
    {
      id: 2,
      node_type: "message",
      position: { x: 200, y: 50 },
      actions: [
        { action_type: "send_message", order: 1, config: { message_text: "Hola {full_name} 👋", typing_delay_seconds: 3 } },
        { action_type: "delay_between_messages", order: 2, config: { delay_seconds: 5, delay_min_seconds: 4, delay_max_seconds: 8 } },
        {
          action_type: "send_file",
          order: 3,
          config: { file_url: "", file_name: "guia.pdf", media_file_info: { url: "https://cdn.test/guia", filename: "guia.pdf" } },
        },
        {
          action_type: "send_multi_media",
          order: 4,
          config: { media_type: "audio", media_file_info: { url: "https://cdn.test/a.mp3", filename: "a.mp3" } },
        },
      ],
    },
    {
      id: 3,
      node_type: "interactive_menu",
      position: { x: 500, y: 50 },
      actions: [
        {
          action_type: "send_interactive_menu",
          config: {
            message: "¿Cómo pagas?",
            menuType: "button",
            options: [
              { id: "op_a", title: "TRANSFERENCIA" },
              { id: "op_b", title: "OXXO" },
            ],
          },
        },
      ],
    },
    {
      id: 4,
      node_type: "wait_response",
      position: { x: 800, y: 0 },
      actions: [
        { action_type: "send_message", order: 1, config: { message: "¿Te lo envío?" } },
        {
          action_type: "wait_for_response",
          order: 2,
          config: { timeout_unit: "minutes", timeout_value: 35, buffer_enabled: true, buffer_value: 5, react_to_lead_check_enabled: true },
        },
        { action_type: "save_user_data", order: 3, config: { field_name: "resposta" } },
      ],
    },
    {
      id: 5,
      node_type: "condition",
      position: { x: 1100, y: 0 },
      actions: [
        {
          action_type: "evaluate_condition",
          config: {
            ruleType: "any",
            conditions: [
              { id: "c1", category: "custom_field", fieldName: "resposta", fieldValue: "no", fieldOperator: "contains" },
              { id: "c2", category: "system", systemSubtype: "tag", tagName: "PARTE 1", systemOperator: "equal" },
            ],
          },
        },
      ],
    },
    { id: 6, node_type: "tags", position: { x: 1400, y: 0 }, actions: [{ action_type: "add_tags", config: { tags: ["PARTE 1"], action: "add" } }] },
    {
      id: 7,
      node_type: "payment",
      position: { x: 1400, y: 200 },
      actions: [{ action_type: "create_payment_charge", config: { amount: "100,00", currency: "MXN", gateway: "xpag" } }],
    },
    { id: 8, node_type: "smart_interval", position: { x: 500, y: 300 }, actions: [{ action_type: "smart_interval", config: { schedule_type: "time", interval_value: 2, interval_unit: "hours" } }] },
    { id: 9, node_type: "make_call", position: { x: 800, y: 300 }, actions: [{ action_type: "make_call", config: {} }] },
    { id: 10, node_type: "message", position: { x: 1100, y: 300 }, actions: [{ action_type: "send_message", config: { message_text: "Fin" } }] },
  ],
  connections: [
    { from_node_id: 1, to_node_id: 2, condition_type: "always", condition_config: {} },
    { from_node_id: 2, to_node_id: 3, condition_type: "always", condition_config: { type: "always" } },
    { from_node_id: 3, to_node_id: 4, condition_type: "menu_option", condition_config: { option_id: "op_a", option_index: 0 } },
    { from_node_id: 3, to_node_id: 8, condition_type: "menu_option", condition_config: { option_index: 1 } },
    { from_node_id: 4, to_node_id: 5, condition_type: "always", condition_config: { response_type: "client-response", source_handle: "client-response" } },
    { from_node_id: 4, to_node_id: 10, condition_type: "timeout_or_unknown", condition_config: { response_type: "timeout", source_handle: "timeout" } },
    { from_node_id: 5, to_node_id: 6, condition_type: "always", condition_config: { condition_result: "success" } },
    { from_node_id: 5, to_node_id: 7, condition_type: "always", condition_config: { condition_result: "failure" } },
    { from_node_id: 7, to_node_id: 10, condition_type: "always", condition_config: { condition_result: "payment_approved" } },
    { from_node_id: 8, to_node_id: 9, condition_type: "always", condition_config: {} },
    { from_node_id: 9, to_node_id: 10, condition_type: "always", condition_config: {} },
  ],
};

const tagId = (n: string) => (n === "PARTE 1" ? "tag-uuid-1" : null);
const nodo = (r: ReturnType<typeof convertirFlujoLeona>, key: string) => r.nodes.find((n) => n.node_key === key)!;

describe("importar flujos de Leona", () => {
  const r = convertirFlujoLeona(LEONA, { tagId });

  it("reconoce el formato de Leona", () => {
    expect(esFlujoLeona(LEONA)).toBe(true);
    expect(esFlujoLeona({ nodes: [{ node_key: "a", node_type: "x", config: {} }] })).toBe(false);
  });

  it("copia todos los bloques con su posición", () => {
    expect(r.nodes).toHaveLength(10);
    expect(r.entry_node_id).toBe("start");
    expect(nodo(r, "start").position_x).toBe(-100);
    expect(nodo(r, "n2").position_x).toBe(200);
  });

  it("no pierde ninguna línea", () => {
    const keys = new Set(r.nodes.map((n) => n.node_key));
    const lineas = deriveCanvasEdges(
      r.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type as never, config: n.config })),
    );
    // 11 conexiones en Leona; 0 quedan sueltas.
    expect(lineas).toHaveLength(LEONA.connections!.length);
    for (const l of lineas) expect(keys.has(l.target)).toBe(true);
  });

  it("Mensaje: texto con variables, pausa, archivo y audio en orden", () => {
    const items = nodo(r, "n2").config.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.tipo)).toEqual(["text", "interval", "document", "audio"]);
    expect(items[0]).toMatchObject({ text: "Hola {{contact.name}} 👋", segundos: 3 });
    expect(items[1].segundos).toBe(6);
    expect(items[2]).toMatchObject({ media_url: "https://cdn.test/guia", filename: "guia.pdf" });
  });

  it("Menú → botones con su destino (por id o por posición)", () => {
    const b = nodo(r, "n3");
    expect(b.node_type).toBe("send_buttons");
    expect(b.config.buttons).toEqual([
      { reply_id: "op_a", title: "TRANSFERENCIA", next_node_key: "n4" },
      { reply_id: "op_b", title: "OXXO", next_node_key: "n8" },
    ]);
  });

  it("Esperar respuesta: pregunta, 35 min, búfer, reacción y dos salidas", () => {
    expect(nodo(r, "n4")).toMatchObject({
      node_type: "save_reply",
      config: {
        prompt_text: "¿Te lo envío?",
        var_key: "resposta",
        espera_segundos: 2100,
        buffer_segundos: 5,
        reaccionar: true,
        contesto_next: "n5",
        no_contesto_next: "n10",
      },
    });
  });

  it("Condicional: campo y etiqueta, «cualquiera», sí/no", () => {
    const c = nodo(r, "n5").config;
    expect(c.logic).toBe("any");
    expect(c.rules).toEqual([
      { id: "c1", subject: "var", subject_key: "resposta", operator: "contains", value: "no" },
      { id: "c2", subject: "tag", subject_key: "tag-uuid-1", operator: "present" },
    ]);
    expect(c).toMatchObject({ true_next: "n6", false_next: "n7" });
  });

  it("Etiquetas, Pago, Intervalo", () => {
    expect(nodo(r, "n6").config).toMatchObject({ mode: "add", tag_ids: ["tag-uuid-1"] });
    expect(nodo(r, "n7")).toMatchObject({ node_type: "payment_gateway", config: { amount: 100, approved_next: "n10" } });
    expect(nodo(r, "n8").config).toMatchObject({ modo: "intervalo", segundos: 7200, next_node_key: "n9" });
  });

  it("lo que no existe aquí queda como paso y avisa", () => {
    expect(nodo(r, "n9")).toMatchObject({ node_type: "wait", config: { segundos: 0, next_node_key: "n10" } });
    expect(r.avisos.some((a) => a.includes("make_call"))).toBe(true);
  });

  it("lista las etiquetas que hay que crear", () => {
    expect(etiquetasDelFlujo(LEONA)).toEqual(["PARTE 1"]);
  });

  it("variables de Leona → WaCRM", () => {
    expect(convertirVariables("{phone_number} {gateway.value} {last_message}")).toBe(
      "{{contact.phone}} {{vars.gateway_value}} {{last_user_message}}",
    );
    expect(convertirVariables("{{vars.x}} se queda")).toBe("{{vars.x}} se queda");
  });
});
