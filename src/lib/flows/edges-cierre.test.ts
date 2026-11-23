import { describe, expect, it } from 'vitest';
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots } from './edges';
import type { BuilderNode } from '@/components/flows/shared';

function nodo(
  key: string,
  type: BuilderNode['node_type'],
  config: Record<string, unknown>,
): BuilderNode {
  return { node_key: key, node_type: type, config };
}

describe('aristas de los bloques de cierre', () => {
  it('expone las tres salidas de la pasarela', () => {
    const n = nodo('pago', 'payment_gateway', {});
    expect(outgoingSlots(n).map((s) => s.id)).toEqual([
      'approved',
      'rejected',
      'timeout',
    ]);
    expect(applyEdgeConnection(n, 'approved', 'ok')).toEqual({
      approved_next: 'ok',
    });
    expect(applyEdgeConnection(n, 'timeout', 'fin')).toEqual({
      timeout_next: 'fin',
    });
  });

  it('expone permiso concedido/denegado/sin respuesta', () => {
    const n = nodo('llamada', 'official_call', {});
    expect(outgoingSlots(n).map((s) => s.id)).toEqual([
      'granted',
      'denied',
      'timeout',
    ]);
    expect(applyEdgeConnection(n, 'granted', 'agente')).toEqual({
      granted_next: 'agente',
    });
  });

  it('dibuja las aristas de pago y llamada', () => {
    const nodes = [
      nodo('inicio', 'start', { next_node_key: 'pago' }),
      nodo('pago', 'payment_gateway', {
        approved_next: 'ok',
        rejected_next: 'no',
      }),
      nodo('ok', 'end', {}),
      nodo('no', 'end', {}),
    ];
    const edges = deriveCanvasEdges(nodes);
    expect(edges.some((e) => e.source === 'pago' && e.sourceHandle === 'approved')).toBe(true);
    expect(edges.some((e) => e.source === 'pago' && e.sourceHandle === 'rejected')).toBe(true);
  });

  it('incluye la salida fuera de ventana del intervalo', () => {
    const n = nodo('espera', 'wait', {
      next_node_key: 'a',
      fuera_ventana_next: 'b',
    });
    expect(outgoingSlots(n).map((s) => s.id)).toEqual(['next', 'fuera_ventana']);
    expect(applyEdgeConnection(n, 'fuera_ventana', 'c')).toEqual({
      fuera_ventana_next: 'c',
    });
  });
});
