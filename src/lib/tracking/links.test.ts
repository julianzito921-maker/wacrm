import { describe, expect, it } from 'vitest';
import {
  aplicarUtmsPorDefecto,
  construirUrlEnlace,
  construirUrlWhatsApp,
  extraerCodigo,
  generarTokenClic,
  limpiarParams,
  normalizarTelefono,
  parametrosDeUrl,
  slugValido,
  slugify,
} from './links';

describe('slugify', () => {
  it('quita acentos y símbolos', () => {
    expect(slugify('Promo Glúteos 🍑')).toBe('promo-gluteos');
    expect(slugify('  --Hola--  ')).toBe('hola');
    expect(slugify('')).toBe('enlace');
  });

  it('valida la ruta pública', () => {
    expect(slugValido('promo-1')).toBe(true);
    expect(slugValido('Promo')).toBe(false);
    expect(slugValido('ab')).toBe(false);
    expect(slugValido('con espacio')).toBe(false);
  });
});

describe('teléfonos y URLs', () => {
  it('normaliza el número de wa.me', () => {
    expect(normalizarTelefono('+52 1 55 1234 5678')).toBe('5215512345678');
    expect(normalizarTelefono('123')).toBeNull();
    expect(normalizarTelefono(null)).toBeNull();
  });

  it('construye la URL de WhatsApp con el código', () => {
    const url = construirUrlWhatsApp('+52 1 55 1234 5678', 'Hola', 'abc123');
    expect(url).not.toBeNull();
    const u = new URL(url as string);
    expect(u.hostname).toBe('wa.me');
    expect(u.pathname).toBe('/5215512345678');
    expect(u.searchParams.get('text')).toBe('Hola #abc123');
  });

  it('omite el código si el clic no se registró', () => {
    const u = new URL(construirUrlWhatsApp('5215512345678', 'Hola', null) as string);
    expect(u.searchParams.get('text')).toBe('Hola');
  });

  it('construye el enlace público con UTMs', () => {
    expect(
      construirUrlEnlace('https://app.test/', 'promo', { utm_source: 'ig' }),
    ).toBe('https://app.test/r/promo?utm_source=ig');
  });
});

describe('parámetros', () => {
  it('deja solo claves conocidas y recorta', () => {
    expect(
      limpiarParams({
        utm_source: 'ig',
        fbclid: '  ',
        foo: 'x',
        gclid: 'g'.repeat(400),
      }),
    ).toEqual({ utm_source: 'ig', gclid: 'g'.repeat(300) });
  });

  it('aplica las UTMs por defecto sin pisar las del anuncio', () => {
    expect(
      aplicarUtmsPorDefecto(
        { utm_source: 'ad' },
        { utm_source: 'def', utm_campaign: 'c1' },
      ),
    ).toEqual({ utm_source: 'ad', utm_campaign: 'c1' });
  });

  it('lee los parámetros de una URL de referral', () => {
    expect(
      parametrosDeUrl('https://fb.com/x?utm_source=fb&gclid=g1&otro=1'),
    ).toEqual({ utm_source: 'fb', gclid: 'g1' });
    expect(parametrosDeUrl('no es url')).toEqual({});
  });
});

describe('código corto', () => {
  it('lo extrae del final y limpia el texto', () => {
    expect(extraerCodigo('Hola #ABC123')).toEqual({
      token: 'abc123',
      limpio: 'Hola',
    });
    expect(extraerCodigo('Quiero info #a1b2c3')).toEqual({
      token: 'a1b2c3',
      limpio: 'Quiero info',
    });
  });

  it('no toca textos sin código de 6', () => {
    expect(extraerCodigo('Hola #abc12')).toBeNull();
    expect(extraerCodigo('Hola')).toBeNull();
    expect(extraerCodigo(null)).toBeNull();
  });

  it('genera tokens de 6', () => {
    expect(generarTokenClic()).toMatch(/^[a-z0-9]{6}$/);
  });
});
