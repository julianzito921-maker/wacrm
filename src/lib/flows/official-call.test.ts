import { describe, expect, it } from 'vitest';
import {
  disponibilidadPorPais,
  estadoDesdeSettings,
  interpretarPermisoLlamada,
  paisDeTelefono,
} from './official-call';

describe('llamada oficial', () => {
  it('detecta el país por prefijo', () => {
    expect(paisDeTelefono('+52 55 1234 5678')).toBe('MX');
    expect(paisDeTelefono('+1 555 123 4567')).toBe('US');
    expect(paisDeTelefono('+20 100 000 0000')).toBe('EG');
    expect(paisDeTelefono('')).toBeNull();
  });

  it('avisa por país y por límite de mensajería', () => {
    expect(disponibilidadPorPais('+52 55 1234 5678', 'TIER_2K').supported).toBe(true);
    expect(disponibilidadPorPais('+1 555 123 4567', 'TIER_2K').reason).toBe(
      'pais_no_soportado',
    );
    expect(disponibilidadPorPais('+52 55 1234 5678', 'TIER_1K').reason).toBe(
      'sin_limite_2000',
    );
  });

  it('lee el estado de calling de Meta', () => {
    expect(
      estadoDesdeSettings({ calling: { status: 'ENABLED' } }).supported,
    ).toBe(true);
    expect(
      estadoDesdeSettings({ calling: { status: 'DISABLED' } }).reason,
    ).toBe('calling_deshabilitado');
    expect(
      estadoDesdeSettings({
        calling: {
          status: 'ENABLED',
          restrictions: {
            restrictions_list: [{ type: 'BUSINESS_INITIATED', reason: 'PAUSED' }],
          },
        },
      }).reason,
    ).toBe('restringido');
  });

  it('interpreta call_permission_reply', () => {
    expect(
      interpretarPermisoLlamada({
        call_permission_reply: {
          response: 'accept',
          is_permanent: true,
          expiration_timestamp: 1_900_000_000,
        },
      }),
    ).toEqual({
      response: 'accept',
      is_permanent: true,
      expiration_timestamp: 1_900_000_000,
    });
    expect(interpretarPermisoLlamada({})).toBeNull();
  });
});
