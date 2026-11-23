import { describe, expect, it } from 'vitest';
import {
  extraerRutaJson,
  mapearRespuesta,
  valorAVariable,
} from './http-request';

describe('mapeo de respuestas HTTP', () => {
  const json = {
    data: {
      id: 'ped_1',
      items: [{ sku: 'A' }, { sku: 'B' }],
      ok: true,
      total: 99.5,
    },
  };

  it('extrae rutas con puntos y corchetes', () => {
    expect(extraerRutaJson(json, 'data.id')).toBe('ped_1');
    expect(extraerRutaJson(json, '$.data.items[1].sku')).toBe('B');
    expect(extraerRutaJson(json, 'data.ok')).toBe(true);
    expect(extraerRutaJson(json, 'data.nope')).toBeUndefined();
  });

  it('mapea varios valores a variables de texto', () => {
    expect(
      mapearRespuesta(json, [
        { path: 'data.id', var_key: 'pedido_id' },
        { path: 'data.total', var_key: 'total' },
        { path: 'data.ok', var_key: 'ok' },
      ]),
    ).toEqual({ pedido_id: 'ped_1', total: '99.5', ok: 'true' });
  });

  it('serializa objetos y vacía los ausentes', () => {
    expect(valorAVariable({ a: 1 })).toBe('{"a":1}');
    expect(valorAVariable(undefined)).toBe('');
    expect(valorAVariable(null)).toBe('');
  });
});
