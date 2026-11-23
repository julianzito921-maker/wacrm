import { describe, expect, it } from 'vitest';
import {
  diaCalentamiento,
  estadoCalentamiento,
  limiteCalentamiento,
} from './warmup';

describe('calentamiento progresivo', () => {
  const start = '2026-01-01T00:00:00.000Z';

  it('calcula el día 1-based', () => {
    expect(diaCalentamiento(start, new Date('2026-01-01T12:00:00Z'))).toBe(1);
    expect(diaCalentamiento(start, new Date('2026-01-03T12:00:00Z'))).toBe(3);
    expect(diaCalentamiento(null)).toBeNull();
  });

  it('aplica 50/50/120/120/250/250/250', () => {
    const limites = [1, 2, 3, 4, 5, 6, 7, 8].map((d) =>
      limiteCalentamiento(start, new Date(`2026-01-0${d}T12:00:00Z`)),
    );
    expect(limites).toEqual([50, 50, 120, 120, 250, 250, 250, null]);
  });

  it('respeta el switch apagado', () => {
    expect(
      estadoCalentamiento({ warmup_enabled: false, warmup_started_at: start }),
    ).toEqual({ dia: null, limite: null, habilitado: false });
    expect(
      estadoCalentamiento(
        { warmup_enabled: true, warmup_started_at: start },
        new Date('2026-01-01T12:00:00Z'),
      ),
    ).toMatchObject({ habilitado: true, limite: 50 });
  });
});
