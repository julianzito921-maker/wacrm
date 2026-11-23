import { describe, expect, it } from 'vitest';
import { applyEdgeConnection } from './edges';

const nodo = (node_type: string, config: Record<string, unknown>) =>
  ({ node_key: 'n1', node_type, config }) as never;

describe('handles de los bloques finales', () => {
  it('guarda la salida del distribuidor elegida', () => {
    expect(
      applyEdgeConnection(
        nodo('distributor', {
          outputs: [
            { id: 'o1', label: 'A', next_node_key: '' },
            { id: 'o2', label: 'B', next_node_key: '' },
          ],
        }),
        'out:o2',
        'fin',
      ),
    ).toEqual({
      outputs: [
        { id: 'o1', label: 'A', next_node_key: '' },
        { id: 'o2', label: 'B', next_node_key: 'fin' },
      ],
    });
  });

  it('guarda el botón y el timeout del carrusel', () => {
    const cfg = {
      cards: [
        {
          id: 'c1',
          text: 'Hola',
          buttons: [
            { id: 'b1', label: 'Sí', type: 'reply', next_node_key: '' },
            { id: 'b2', label: 'No', type: 'reply', next_node_key: '' },
          ],
        },
      ],
      timeout_next: '',
    };
    expect(applyEdgeConnection(nodo('carousel', cfg), 'car_c1_b1', 'pago')).toEqual({
      cards: [
        {
          id: 'c1',
          text: 'Hola',
          buttons: [
            { id: 'b1', label: 'Sí', type: 'reply', next_node_key: 'pago' },
            { id: 'b2', label: 'No', type: 'reply', next_node_key: '' },
          ],
        },
      ],
    });
    expect(applyEdgeConnection(nodo('carousel', cfg), 'timeout', 'fin')).toEqual({
      timeout_next: 'fin',
    });
  });
});
