import { describe, expect, it } from 'vitest';
import {
  normalizeFunnel,
  parseDuration,
  NormalizeError,
  type McpWorkspaceData,
} from './normalizer';
import { validateFlowForActivation } from '@/lib/flows/validate';

const WORKSPACE: McpWorkspaceData = {
  pipelines: [
    {
      id: 'p1',
      name: 'Ventas',
      stages: [
        { id: 's1', name: 'Nuevo', position: 0 },
        { id: 's2', name: 'Pagado', position: 1 },
      ],
    },
  ],
  tags: [{ id: 't1', name: 'cliente' }],
  templates: [{ name: 'bienvenida', language: 'es_MX' }],
};

describe('parseDuration', () => {
  it('entiende segundos y formatos humanos', () => {
    expect(parseDuration(120, 0)).toBe(120);
    expect(parseDuration('45s', 0)).toBe(45);
    expect(parseDuration('1d 2h 30m', 0)).toBe(82_800); // tope 23 h
    expect(parseDuration(undefined, 7)).toBe(7);
  });

  it('rechaza texto inválido', () => {
    expect(() => parseDuration('pronto', 0)).toThrow(NormalizeError);
  });
});

describe('normalizeFunnel', () => {
  it('crea el start, resuelve nombres y usa un solo fin', () => {
    const out = normalizeFunnel(
      {
        name: 'Embudo de prueba',
        trigger: { type: 'keyword', keywords: ['precio'] },
        nodes: [
          {
            type: 'message',
            messages: [
              { type: 'text', text: 'Hola' },
              {
                type: 'image',
                url: 'https://x/1.jpg',
                caption: 'Mira',
                seconds: 70,
              },
            ],
          },
          { type: 'wait_reply', var: 'resp', prompt: '¿Te ayudo?', wait: '1d' },
          { type: 'payment', amount: 499 },
          { type: 'kanban', pipeline: 'Ventas', stage: 'Pagado' },
          { type: 'capi', event: 'Purchase', value: 499 },
          { type: 'end' },
        ],
      },
      WORKSPACE,
    );

    expect(out.nodes.map((n) => n.node_key)).toEqual([
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
      'n7',
    ]);
    expect(out.entry_node_id).toBe('n1');
    expect(out.nodes[0]).toMatchObject({
      node_type: 'start',
      config: { next_node_key: 'n2' },
    });
    const msg = out.nodes[1];
    const items = msg.config.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.tipo)).toEqual(['text', 'interval', 'image']);
    expect(items[1].segundos).toBe(70);
    expect(items[2].segundos).toBe(0);

    const espera = out.nodes[2];
    expect(espera.config).toMatchObject({
      var_key: 'resp',
      contesto_next: 'n4',
      no_contesto_next: 'n7',
      espera_segundos: 82_800,
    });
    const pago = out.nodes[3];
    expect(pago.config).toMatchObject({
      monto: 499,
      aprobado_next: 'n5',
      rechazado_next: 'n7',
    });
    const kanban = out.nodes[4];
    expect(kanban.config).toMatchObject({
      pipeline_id: 'p1',
      stage_id: 's2',
      next_node_key: 'n6',
    });
    expect(out.nodes[5].config).toMatchObject({
      event_name: 'Purchase',
      value: 499,
      next_node_key: 'n7',
    });

    const issues = validateFlowForActivation(
      {
        name: out.name,
        trigger_type: out.trigger_type,
        trigger_config: out.trigger_config,
        entry_node_id: out.entry_node_id,
      },
      out.nodes,
    );
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('respeta claves y ramas explícitas', () => {
    const out = normalizeFunnel(
      {
        name: 'Ramas',
        nodes: [
          { key: 'inicio', type: 'start', next: 'msg' },
          {
            key: 'msg',
            type: 'message',
            messages: [{ type: 'text', text: 'Hola' }],
          },
          {
            key: 'espera',
            type: 'wait_reply',
            var: 'x',
            wait: '2h',
            no_reply_next: 'fin',
          },
          {
            key: 'pago',
            type: 'payment',
            amount: 100,
            approved_next: 'fin',
            rejected_next: 'fin',
          },
          { key: 'fin', type: 'end' },
        ],
      },
      WORKSPACE,
    );
    expect(out.nodes[0].config.next_node_key).toBe('msg');
    expect(out.nodes[1].config.next_node_key).toBe('espera');
    expect(out.nodes[2].config).toMatchObject({
      contesto_next: 'pago',
      no_contesto_next: 'fin',
      espera_segundos: 7_200,
    });
    // No se añade un fin extra cuando ya hay uno.
    expect(out.nodes.filter((n) => n.node_type === 'end')).toHaveLength(1);
  });

  it('en espera indefinida no exige rama de no contesta', () => {
    const out = normalizeFunnel(
      {
        name: 'Indefinido',
        nodes: [
          { type: 'start' },
          { type: 'wait_reply', indefinite: true },
          { type: 'end' },
        ],
      },
      WORKSPACE,
    );
    const espera = out.nodes.find((n) => n.node_type === 'save_reply');
    expect(espera?.config).toMatchObject({
      esperar_indefinido: true,
      no_contesto_next: '',
    });
  });

  it('falla con nombres inexistentes o ambiguos', () => {
    expect(() =>
      normalizeFunnel(
        {
          name: 'Malo',
          nodes: [
            { type: 'start' },
            { type: 'kanban', pipeline: 'No existe', stage: 'X' },
            { type: 'end' },
          ],
        },
        WORKSPACE,
      ),
    ).toThrow(/Embudo «No existe» no existe/);

    expect(() =>
      normalizeFunnel(
        {
          name: 'Malo',
          nodes: [
            { type: 'start' },
            { type: 'kanban', pipeline: 'Ventas', stage: 'No existe' },
            { type: 'end' },
          ],
        },
        WORKSPACE,
      ),
    ).toThrow(/Etapa de Ventas/);
  });

  it('rechaza claves repetidas', () => {
    expect(() =>
      normalizeFunnel(
        {
          name: 'Repetido',
          nodes: [
            { key: 'x', type: 'start' },
            { key: 'x', type: 'end' },
          ],
        },
        WORKSPACE,
      ),
    ).toThrow(/repetidas/);
  });
});
