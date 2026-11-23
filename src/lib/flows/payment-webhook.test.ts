import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  firmaHotmartValida,
  firmaMercadoPagoValida,
  firmaSpeiValida,
  firmaStripeValida,
  firmaWhopValida,
} from './payment-webhook';

describe('firmas de webhooks de pago', () => {
  const ahora = 1_800_000_000;

  it('valida Stripe con tolerancia', () => {
    const secret = 'whsec_test';
    const raw = '{"id":"evt_1"}';
    const t = ahora;
    const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    expect(
      firmaStripeValida({
        header: `t=${t},v1=${v1}`,
        rawBody: raw,
        secret,
        ahora,
      }),
    ).toBe(true);
    expect(
      firmaStripeValida({
        header: `t=${t - 400},v1=${v1}`,
        rawBody: raw,
        secret,
        ahora,
      }),
    ).toBe(false);
  });

  it('valida Whop Standard Webhooks', () => {
    const key = 'super-secret-key';
    const secret = `ws_${Buffer.from(key).toString('base64')}`;
    const raw = '{"type":"payment.succeeded"}';
    const id = 'wh_1';
    const ts = String(ahora);
    const sig = createHmac('sha256', key)
      .update(`${id}.${ts}.${raw}`)
      .digest('base64');
    expect(
      firmaWhopValida({
        id,
        timestamp: ts,
        signature: `v1,${sig}`,
        rawBody: raw,
        secret,
        ahora,
      }),
    ).toBe(true);
  });

  it('valida Mercado Pago con manifiesto', () => {
    const secret = 'mp_test';
    const ts = String(ahora);
    const dataId = '123';
    const requestId = 'req_1';
    const manifiesto = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', secret).update(manifiesto).digest('hex');
    expect(
      firmaMercadoPagoValida({
        signature: `ts=${ts},v1=${v1}`,
        requestId,
        dataId,
        secret,
        ahora,
      }),
    ).toBe(true);
  });

  it('valida Hotmart hottok y SPEI HMAC', () => {
    expect(firmaHotmartValida('abc', 'abc')).toBe(true);
    expect(firmaHotmartValida('abc', 'otro')).toBe(false);
    const raw = '{"ok":true}';
    const sig = createHmac('sha256', 'spei').update(raw).digest('hex');
    expect(firmaSpeiValida({ header: sig, rawBody: raw, secret: 'spei' })).toBe(true);
  });
});
