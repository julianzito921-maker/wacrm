import { describe, expect, it } from 'vitest';
import {
  esperaProgramadaSegundos,
  instanteEnZona,
  minutosDeHora,
  partesEnZona,
  proximaVentana,
} from './agenda';

const MEX = 'America/Mexico_City';

describe('agenda del Intervalo inteligente', () => {
  it('convierte horas de pared a minutos', () => {
    expect(minutosDeHora('09:00')).toBe(540);
    expect(minutosDeHora('23:59')).toBe(1439);
    expect(minutosDeHora('24:00')).toBeNull();
    expect(minutosDeHora('9')).toBeNull();
  });

  it('lee las partes locales en la zona de la cuenta', () => {
    const p = partesEnZona(new Date('2026-01-15T15:00:00Z'), MEX);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(1);
    expect(p.day).toBe(15);
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(0);
    expect(p.weekday).toBe(4); // jueves
  });

  it('respeta la ventana si ya está abierta', () => {
    const now = new Date('2026-01-05T15:00:00Z'); // lunes 09:00 CDMX
    const v = proximaVentana(
      now,
      { dias: [1, 2, 3, 4, 5], desde: '09:00', hasta: '18:00' },
      MEX,
    );
    expect(v?.despertarEn.getTime()).toBe(now.getTime());
  });

  it('salta al lunes cuando es fin de semana', () => {
    const now = new Date('2026-01-03T15:00:00Z'); // sábado 09:00 CDMX
    const v = proximaVentana(
      now,
      { dias: [1, 2, 3, 4, 5], desde: '09:00', hasta: '18:00' },
      MEX,
    );
    expect(v?.despertarEn.toISOString()).toBe('2026-01-05T15:00:00.000Z');
  });

  it('soporta ventanas que cruzan medianoche', () => {
    const ahora = new Date('2026-01-06T06:30:00Z'); // martes 00:30 CDMX, dentro de la ventana
    const dentro = proximaVentana(
      ahora,
      { dias: [1, 2, 3, 4, 5], desde: '22:00', hasta: '02:00' },
      MEX,
    );
    expect(dentro?.despertarEn.getTime()).toBe(ahora.getTime());

    const despues = new Date('2026-01-06T09:00:00Z'); // martes 03:00 CDMX, ya cerró
    const v = proximaVentana(
      despues,
      { dias: [1, 2, 3, 4, 5], desde: '22:00', hasta: '02:00' },
      MEX,
    );
    expect(v?.despertarEn.toISOString()).toBe('2026-01-07T04:00:00.000Z');
  });

  it('calcula la espera hasta una fecha', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const segundos = esperaProgramadaSegundos({
      modo: 'fecha',
      fecha_objetivo: '2026-01-01T00:01:00Z',
      timeZonePorDefecto: MEX,
      now,
    });
    expect(segundos).toBe(60);
  });

  it('convierte una hora local a UTC', () => {
    expect(instanteEnZona(2026, 1, 15, 9, 0, MEX).toISOString()).toBe(
      '2026-01-15T15:00:00.000Z',
    );
  });
});
