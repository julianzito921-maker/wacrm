import { describe, expect, it } from 'vitest';
import { CurlInvalido, parsearCurl, tokenizarCurl } from './curl';

describe('parser de cURL', () => {
  it('extrae método, URL, cabeceras y body', () => {
    const r = parsearCurl(
      `curl -X POST 'https://api.ejemplo.com/pedidos' \\
        -H 'Content-Type: application/json' \\
        -H 'Authorization: Bearer abc' \\
        --data-raw '{"cliente":"Ana","total":99}'`,
    );
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.ejemplo.com/pedidos');
    expect(r.headers).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Authorization', value: 'Bearer abc' },
    ]);
    expect(r.body).toBe('{"cliente":"Ana","total":99}');
  });

  it('usa GET sin body y POST con body', () => {
    expect(parsearCurl('curl https://ejemplo.com').method).toBe('GET');
    expect(
      parsearCurl(`curl https://ejemplo.com -d 'a=1'`).method,
    ).toBe('POST');
  });

  it('convierte -u en Authorization Basic', () => {
    const r = parsearCurl('curl -u user:pass https://ejemplo.com');
    expect(r.headers[0]).toEqual({
      key: 'Authorization',
      value: 'Basic dXNlcjpwYXNz',
    });
  });

  it('mueve el body a query string con -G', () => {
    const r = parsearCurl(`curl -G https://ejemplo.com -d 'a=1' -d 'b=2'`);
    expect(r.url).toBe('https://ejemplo.com?a=1&b=2');
    expect(r.body).toBe('');
  });

  it('rechaza archivos @ y URLs no http', () => {
    expect(() => parsearCurl(`curl https://x.com -d @archivo.json`)).toThrow(
      CurlInvalido,
    );
    expect(() => parsearCurl('curl ftp://x.com')).toThrow(CurlInvalido);
  });

  it('tokeniza comillas simples y dobles', () => {
    expect(tokenizarCurl(`curl "https://x.com?a=1" 'ok'`)).toEqual([
      'curl',
      'https://x.com?a=1',
      'ok',
    ]);
  });
});
