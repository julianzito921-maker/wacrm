import { describe, expect, it } from 'vitest';
import {
  combinarCondiciones,
  parsearSalidaIa,
  puedeTransferir,
  reglasDeCondicion,
} from './bloques-avanzados';

describe('bloques avanzados', () => {
  it('combina reglas con Y/O', () => {
    expect(combinarCondiciones([true, false], 'all')).toBe(false);
    expect(combinarCondiciones([true, false], 'any')).toBe(true);
    expect(combinarCondiciones([], 'any')).toBe(false);
  });

  it('parsea JSON limpio, con fences y fallback', () => {
    expect(parsearSalidaIa('{"respuesta":"Hola","salida":"c1"}')).toEqual({
      respuesta: 'Hola',
      salida: 'c1',
    });
    expect(
      parsearSalidaIa('```json\n{"respuesta":"Hola","salida":"c2"}\n```'),
    ).toEqual({ respuesta: 'Hola', salida: 'c2' });
    expect(parsearSalidaIa('solo texto')).toEqual({
      respuesta: 'solo texto',
      salida: null,
    });
  });

  it('limita la cadena de transferencias a 5', () => {
    expect(puedeTransferir([], 'f2')).toBe(true);
    expect(puedeTransferir(['f2'], 'f2')).toBe(false);
    expect(puedeTransferir(['a', 'b', 'c', 'd', 'e'], 'f2')).toBe(false);
  });

  it('normaliza la regla vieja del condicional', () => {
    expect(
      reglasDeCondicion({
        subject: 'var',
        subject_key: 'x',
        operator: 'equals',
        value: '1',
      }),
    ).toEqual([
      {
        id: 'legacy',
        subject: 'var',
        subject_key: 'x',
        operator: 'equals',
        value: '1',
      },
    ]);
  });
});

describe('conexión de handles del bloque de IA', () => {
  it('guarda la condición, el comprobante y el fallback', async () => {
    const { aplicarConexionAiBlock } = await import('./bloques-avanzados');
    const cfg = {
      conditions: [
        { id: 'c1', label: 'Quiere comprar', next_node_key: '' },
        { id: 'c2', label: 'Duda', next_node_key: '' },
      ],
    };
    expect(aplicarConexionAiBlock(cfg, 'cond:c1', 'pago')).toEqual({
      conditions: [
        { id: 'c1', label: 'Quiere comprar', next_node_key: 'pago' },
        { id: 'c2', label: 'Duda', next_node_key: '' },
      ],
    });
    expect(aplicarConexionAiBlock(cfg, 'receipt', 'ok')).toEqual({ receipt_next: 'ok' });
    expect(aplicarConexionAiBlock(cfg, 'fallback', 'fin')).toEqual({ fallback_next: 'fin' });
    expect(aplicarConexionAiBlock(cfg, 'cond:noexiste', 'x')).toBeNull();
  });
});
