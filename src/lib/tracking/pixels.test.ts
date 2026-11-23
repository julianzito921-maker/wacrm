import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('la prueba no debe tocar la base');
  },
}));

import { elegirCredenciales } from './pixels';

describe('elegirCredenciales', () => {
  it('prefiere el píxel de la cuenta y su token', () => {
    expect(
      elegirCredenciales(
        {
          pixel_id: '123',
          access_token: 'token-pixel',
          test_event_code: 'TEST1',
        },
        { dataset: 'env', token: 'env-token' },
      ),
    ).toEqual({
      pixelId: '123',
      token: 'token-pixel',
      testEventCode: 'TEST1',
      origen: 'pixel',
    });
  });

  it('usa el token de entorno si el píxel no tiene token', () => {
    expect(
      elegirCredenciales(
        { pixel_id: '123', access_token: null, test_event_code: null },
        { token: 'env-token' },
      ),
    ).toMatchObject({ pixelId: '123', token: 'env-token', origen: 'pixel' });
  });

  it('cae al respaldo por entorno sin píxel', () => {
    expect(
      elegirCredenciales(null, { dataset: '999', token: 'env-token' }),
    ).toEqual({
      pixelId: '999',
      token: 'env-token',
      testEventCode: undefined,
      origen: 'env',
    });
  });

  it('devuelve null si no hay ninguna configuración', () => {
    expect(elegirCredenciales(null, {})).toBeNull();
  });
});
