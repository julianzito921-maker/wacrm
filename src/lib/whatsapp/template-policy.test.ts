import { describe, expect, it } from 'vitest';
import { analizarPlantilla, tieneBotonBaja } from './template-policy';

const base = {
  name: 'promo',
  category: 'Marketing' as const,
  language: 'es_MX',
  body_text: 'Hola {{1}}, mira la promo.',
};

describe('política de plantillas como advertencia', () => {
  it('sugiere botón de baja en MARKETING', () => {
    const avisos = analizarPlantilla(base);
    expect(avisos.some((a) => a.code === 'marketing_without_opt_out')).toBe(true);
  });

  it('no sugiere si ya hay QUICK_REPLY de baja', () => {
    const avisos = analizarPlantilla({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', text: 'Dejar de recibir mensajes' }],
    });
    expect(avisos.some((a) => a.code === 'marketing_without_opt_out')).toBe(false);
    expect(tieneBotonBaja([{ type: 'QUICK_REPLY', text: 'Dejar de recibir mensajes' }])).toBe(true);
  });

  it('detecta términos de riesgo sin bloquear', () => {
    const avisos = analizarPlantilla({
      ...base,
      category: 'Utility',
      body_text: 'Venta de pistolas y munición.',
    });
    expect(
      avisos.some(
        (a) =>
          a.code === 'commerce_term' && a.term?.startsWith('pistola'),
      ),
    ).toBe(true);
  });

  it('no falsea coincidencias dentro de palabras', () => {
    const avisos = analizarPlantilla({
      ...base,
      category: 'Utility',
      body_text: 'Tu pedido de camisetas está listo.',
    });
    expect(avisos.some((a) => a.code === 'commerce_term')).toBe(false);
  });
});
