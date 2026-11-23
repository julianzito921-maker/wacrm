import { describe, expect, it } from 'vitest';
import {
  correoNormalizado,
  eventoHotmart,
  eventoStripe,
  eventoWhop,
  generarReferencia,
  montoCoincide,
  pagoMercadoPago,
} from './pagos';

describe('normalización de pagos', () => {
  it('genera una referencia con el proveedor', () => {
    const ref = generarReferencia('stripe');
    expect(ref.startsWith('pay_stripe_')).toBe(true);
    expect(ref.length).toBeGreaterThan(20);
  });

  it('normaliza Stripe checkout.session.completed', () => {
    const e = eventoStripe({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          amount_total: 12900,
          currency: 'mxn',
          client_reference_id: 'pay_stripe_abc',
          payment_intent: 'pi_1',
          customer_details: { email: 'Ana@Ejemplo.com' },
        },
      },
    });
    expect(e.status).toBe('approved');
    expect(e.amount).toBe(129);
    expect(e.currency).toBe('MXN');
    expect(e.reference).toBe('pay_stripe_abc');
    expect(e.externalId).toBe('pi_1');
    expect(e.email).toBe('Ana@Ejemplo.com');
  });

  it('normaliza Whop payment.succeeded', () => {
    const e = eventoWhop(
      {
        type: 'payment.succeeded',
        data: {
          id: 'pay_1',
          total: 49,
          currency: 'USD',
          metadata: { payment_ref: 'pay_whop_1' },
          user: { email: 'x@y.com' },
        },
      },
      'wh_1',
    );
    expect(e.status).toBe('approved');
    expect(e.reference).toBe('pay_whop_1');
    expect(e.amount).toBe(49);
    expect(e.currency).toBe('USD');
    expect(e.eventId).toBe('wh_1');
  });

  it('normaliza Hotmart PURCHASE_APPROVED', () => {
    const e = eventoHotmart({
      id: 'hot_1',
      event: 'PURCHASE_APPROVED',
      data: {
        purchase: {
          status: 'APPROVED',
          transaction: 'HP123',
          price: { value: 13.9, currency_value: 'USD' },
          tracking: { source_sck: 'pay_hotmart_1' },
        },
        buyer: { email: 'buyer@example.com' },
      },
    });
    expect(e.status).toBe('approved');
    expect(e.amount).toBe(13.9);
    expect(e.currency).toBe('USD');
    expect(e.reference).toBe('pay_hotmart_1');
    expect(e.externalId).toBe('HP123');
  });

  it('normaliza Mercado Pago aprobado', () => {
    const p = pagoMercadoPago({
      id: 999,
      status: 'approved',
      transaction_amount: 99,
      currency_id: 'MXN',
      external_reference: 'pay_mp_1',
      payer: { email: 'mp@example.com' },
    });
    expect(p).toMatchObject({
      status: 'approved',
      amount: 99,
      currency: 'MXN',
      reference: 'pay_mp_1',
      externalId: '999',
      email: 'mp@example.com',
    });
  });

  it('compara montos con tolerancia de un centavo', () => {
    expect(montoCoincide(99, 99.01)).toBe(true);
    expect(montoCoincide(99, 99.02)).toBe(false);
    expect(montoCoincide(99, null)).toBe(true);
  });

  it('normaliza correos', () => {
    expect(correoNormalizado(' Ana@Ejemplo.com ')).toBe('ana@ejemplo.com');
    expect(correoNormalizado('no-es-correo')).toBeNull();
  });
});
