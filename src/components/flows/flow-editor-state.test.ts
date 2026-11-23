import { describe, it, expect } from "vitest";
import {
  appendNode,
  applyNodePositions,
  buildNewNode,
  defaultConfigFor,
  uniqueNodeKey,
  type BuilderState,
} from "./flow-editor-state";
import type { BuilderNode, NodeType } from "./shared";

describe("uniqueNodeKey", () => {
  it("returns the base key when it isn't taken", () => {
    expect(uniqueNodeKey("menu", [])).toBe("menu");
    expect(
      uniqueNodeKey("menu", [
        { node_key: "other", node_type: "end", config: {} },
      ]),
    ).toBe("menu");
  });

  it("appends _2 when the base is taken", () => {
    expect(
      uniqueNodeKey("menu", [
        { node_key: "menu", node_type: "end", config: {} },
      ]),
    ).toBe("menu_2");
  });

  it("walks forward until it finds an unused suffix", () => {
    const existing: BuilderNode[] = [
      { node_key: "menu", node_type: "end", config: {} },
      { node_key: "menu_2", node_type: "end", config: {} },
      { node_key: "menu_3", node_type: "end", config: {} },
    ];
    expect(uniqueNodeKey("menu", existing)).toBe("menu_4");
  });
});

describe("applyNodePositions", () => {
  it("rounds and applies positions without changing unrelated nodes", () => {
    const nodes: BuilderNode[] = [
      {
        node_key: "start",
        node_type: "start",
        config: {},
        position_x: 0,
        position_y: 0,
      },
      {
        node_key: "message",
        node_type: "send_message",
        config: {},
        position_x: 10,
        position_y: 20,
      },
    ];

    expect(
      applyNodePositions(nodes, {
        start: { x: 10.4, y: 20.6 },
      }),
    ).toEqual([
      {
        node_key: "start",
        node_type: "start",
        config: {},
        position_x: 10,
        position_y: 21,
      },
      {
        node_key: "message",
        node_type: "send_message",
        config: {},
        position_x: 10,
        position_y: 20,
      },
    ]);
  });
});

describe("defaultConfigFor", () => {
  // The hook's addNode and the validator both depend on these defaults
  // being self-consistent. A broken default would surface as a
  // validation error on a freshly-added node, which is exactly what
  // these snapshots guard against.
  const types: NodeType[] = [
    "start",
    "send_message",
    "send_buttons",
    "send_list",
    "send_media",
    "collect_input",
    "condition",
    "set_tag",
    "handoff",
    "end",
  ];

  it("returns an object for every known node type", () => {
    for (const t of types) {
      expect(typeof defaultConfigFor(t)).toBe("object");
    }
  });

  it("send_buttons default has at least one button row", () => {
    const cfg = defaultConfigFor("send_buttons") as {
      buttons?: Array<{ reply_id: string; title: string }>;
    };
    expect(cfg.buttons?.length).toBeGreaterThan(0);
    expect(cfg.buttons?.[0].reply_id).toBeTruthy();
  });

  it("send_list default has at least one section with one row", () => {
    const cfg = defaultConfigFor("send_list") as {
      sections?: Array<{ rows: unknown[] }>;
    };
    expect(cfg.sections?.length).toBeGreaterThan(0);
    expect(cfg.sections?.[0].rows.length).toBeGreaterThan(0);
  });

  it("send_media defaults to image (the most common case)", () => {
    const cfg = defaultConfigFor("send_media") as { media_type?: string };
    expect(cfg.media_type).toBe("image");
  });

  it("collect_input ships a valid var_key that passes the validator regex", () => {
    const cfg = defaultConfigFor("collect_input") as { var_key?: string };
    // Mirrors the regex in validate.ts: alphanumeric + underscore,
    // starts with letter or underscore.
    expect(cfg.var_key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });

  it("end's default is an empty object (terminal — no config)", () => {
    expect(defaultConfigFor("end")).toEqual({});
  });
});

describe("buildNewNode", () => {
  it("gives back-to-back additions distinct keys when fed the running node list", () => {
    let nodes: BuilderNode[] = [];
    const first = buildNewNode("send_message", nodes);
    nodes = [...nodes, first];
    const second = buildNewNode("send_message", nodes);
    expect(second.node_key).not.toBe(first.node_key);
  });
});

describe("appendNode", () => {
  const baseState: BuilderState = {
    name: "f",
    description: "",
    trigger_type: "manual",
    trigger_config: {},
    entry_node_id: null,
    status: "draft",
    nodes: [],
  };

  it("makes the first start node the entry", () => {
    const start = buildNewNode("start", []);
    expect(appendNode(baseState, start).entry_node_id).toBe(start.node_key);
  });

  it("keeps an existing entry", () => {
    const start = buildNewNode("start", []);
    const next = appendNode({ ...baseState, entry_node_id: "existing" }, start);
    expect(next.entry_node_id).toBe("existing");
    expect(next.nodes).toEqual([start]);
  });

  it("does not pick a non-start node as entry", () => {
    const end = buildNewNode("end", []);
    expect(appendNode(baseState, end).entry_node_id).toBeNull();
  });
});

import { removeNodeFromState } from "./flow-editor-state";

const cadena = (): BuilderState => ({
  name: "flujo",
  description: "",
  trigger_type: "keyword",
  trigger_config: {},
  entry_node_id: "a",
  status: "draft",
  nodes: [
    { node_key: "a", node_type: "send_message", config: { text: "hola", next_node_key: "b" } },
    { node_key: "b", node_type: "send_message", config: { text: "medio", next_node_key: "c" } },
    { node_key: "c", node_type: "end", config: {} },
  ],
});

describe("removeNodeFromState", () => {
  it("recostura la cadena: el anterior apunta al siguiente", () => {
    const salida = removeNodeFromState(cadena(), "b");
    expect(salida.nodes.map((n) => n.node_key)).toEqual(["a", "c"]);
    expect(salida.nodes[0].config.next_node_key).toBe("c");
  });

  it("suelta la referencia cuando el nodo tenía varias salidas", () => {
    const estado = cadena();
    estado.nodes = [
      { node_key: "a", node_type: "send_message", config: { text: "hola", next_node_key: "menu" } },
      {
        node_key: "menu",
        node_type: "send_buttons",
        config: {
          text: "elige",
          buttons: [
            { reply_id: "si", title: "Si", next_node_key: "c" },
            { reply_id: "no", title: "No", next_node_key: "c" },
          ],
        },
      },
      { node_key: "c", node_type: "end", config: {} },
    ];
    const salida = removeNodeFromState(estado, "menu");
    expect(salida.nodes.map((n) => n.node_key)).toEqual(["a", "c"]);
    expect(salida.nodes[0].config.next_node_key).toBe("");
  });

  it("deja el flujo sin entrada si se borra el nodo de entrada", () => {
    const salida = removeNodeFromState(cadena(), "a");
    expect(salida.entry_node_id).toBeNull();
    expect(salida.nodes.map((n) => n.node_key)).toEqual(["b", "c"]);
  });

  it("no cambia nada si la clave no existe", () => {
    const estado = cadena();
    expect(removeNodeFromState(estado, "no_existe")).toBe(estado);
  });
});

import { duplicateNodeInState } from "./flow-editor-state";

describe("duplicateNodeInState", () => {
  it("empalma la copia justo detrás en un paso de una sola salida", () => {
    const salida = duplicateNodeInState(cadena(), "a", "a_2");
    expect(salida.nodes.map((n) => n.node_key)).toEqual(["a", "b", "c", "a_2"]);
    const a = salida.nodes.find((n) => n.node_key === "a")!;
    const copia = salida.nodes.find((n) => n.node_key === "a_2")!;
    expect(a.config.next_node_key).toBe("a_2");
    expect(copia.config.next_node_key).toBe("b");
    expect(copia.config.text).toBe("hola");
  });

  it("no toca las uniones cuando el nodo tiene varias salidas", () => {
    const estado: BuilderState = {
      ...cadena(),
      nodes: [
        {
          node_key: "menu",
          node_type: "send_buttons",
          config: {
            text: "elige",
            buttons: [{ reply_id: "si", title: "Si", next_node_key: "c" }],
          },
          position_x: 0,
          position_y: 0,
        },
        { node_key: "c", node_type: "end", config: {} },
      ],
    };
    const salida = duplicateNodeInState(estado, "menu", "menu_2");
    const original = salida.nodes.find((n) => n.node_key === "menu")!;
    expect(original.config.buttons).toEqual([
      { reply_id: "si", title: "Si", next_node_key: "c" },
    ]);
    expect(salida.nodes).toHaveLength(3);
  });

  it("no duplica el contenido por referencia", () => {
    const salida = duplicateNodeInState(cadena(), "a", "a_2");
    const copia = salida.nodes.find((n) => n.node_key === "a_2")!;
    expect(copia.config).not.toBe(salida.nodes[0].config);
  });

  it("devuelve el estado tal cual si la clave no existe", () => {
    const estado = cadena();
    expect(duplicateNodeInState(estado, "no_existe", "x")).toBe(estado);
  });
});

describe("bloque Inicio / Disparador", () => {
  const base = (nodes: BuilderNode[], entry: string | null): BuilderState => ({
    name: "x",
    description: "",
    trigger_type: "keyword",
    trigger_config: { keywords: ["chia"] },
    entry_node_id: entry,
    status: "draft",
    nodes,
  });

  it("antepone un Inicio que apunta a la entrada vieja y lo vuelve la entrada", async () => {
    const { conNodoInicio } = await import("./flow-editor-state");
    const s = conNodoInicio(
      base([{ node_key: "hola", node_type: "send_message", config: { text: "Hola", next_node_key: "" }, position_x: 400, position_y: 80 }], "hola"),
    );
    expect(s.entry_node_id).toBe("inicio");
    expect(s.nodes[0]).toMatchObject({
      node_key: "inicio",
      node_type: "start",
      config: { next_node_key: "hola" },
      position_x: 80,
      position_y: 80,
    });
    // Idempotente: no agrega un segundo Inicio.
    expect(conNodoInicio(s).nodes.filter((n) => n.node_type === "start")).toHaveLength(1);
  });

  it("flujo nuevo vacío: Inicio sin conexión", async () => {
    const { conNodoInicio } = await import("./flow-editor-state");
    const s = conNodoInicio(base([], null));
    expect(s.nodes).toHaveLength(1);
    expect(s.entry_node_id).toBe("inicio");
  });

  it("el Inicio no se puede borrar", async () => {
    const { conNodoInicio, removeNodeFromState } = await import("./flow-editor-state");
    const s = conNodoInicio(base([], null));
    expect(removeNodeFromState(s, "inicio")).toBe(s);
  });

  it("un Mensaje nuevo nace con una burbuja de texto de 3 s", () => {
    expect(defaultConfigFor("send_message")).toMatchObject({
      items: [{ tipo: "text", text: "", segundos: 3, like: false }],
      next_node_key: "",
    });
  });
});
