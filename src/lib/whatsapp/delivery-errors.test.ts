import { describe, expect, it } from 'vitest';
import { clasificarErrorEntrega } from './delivery-errors';

describe('clasificación de errores de entrega', () => {
  it('131049 no se reintenta', () => {
    expect(clasificarErrorEntrega(131049)).toBe('skip_meta_limit');
  });
  it('131050 marca marketing opt-out', () => {
    expect(clasificarErrorEntrega(131050)).toBe('marketing_opt_out');
  });
  it('130429 es rate limit', () => {
    expect(clasificarErrorEntrega(130429)).toBe('rate_limit');
  });
  it('otros son fallo normal', () => {
    expect(clasificarErrorEntrega(131000)).toBe('failed');
  });
});
