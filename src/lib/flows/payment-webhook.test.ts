import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// El motor es pesado y no hace falta aquí: solo se verifica si se llama.
vi.mock('./engine', () => ({
  registrarVentaDeSesionAprobada: vi.fn(),
  resumePaymentGateway: vi.fn(),
}));
// Los secretos de la prueba van en claro; 'NO_DESCIFRA' simula un
// secreto corrupto o cifrado con otra llave.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'NO_DESCIFRA') throw new Error('bad decrypt');
    return v;
  },
}));

import { registrarVentaDeSesionAprobada, resumePaymentGateway } from './engine';
import { urlBaseWebhook } from './pagos';
import {
  firmaHotmartValida,
  firmaMercadoPagoValida,
  firmaSpeiValida,
  firmaStripeValida,
  firmaWhopValida,
  procesarWebhookPago,
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

// ============================================================
// procesarWebhookPago con un Supabase de mentira
// ============================================================

interface Consulta {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  payload?: unknown;
  filtros: Record<string, unknown>;
}

type Respuesta = { data?: unknown; error?: { code?: string; message: string } | null };

/**
 * Cliente mínimo: registra cada consulta y deja que el test decida la
 * respuesta según tabla, operación y filtros.
 */
function dbFalsa(responder: (c: Consulta) => Respuesta | Promise<Respuesta>) {
  const consultas: Consulta[] = [];
  const from = (table: string) => {
    const c: Consulta = { table, op: 'select', filtros: {} };
    let registrada = false;
    const registrar = () => {
      if (!registrada) {
        consultas.push(c);
        registrada = true;
      }
    };
    const resolver = async () => {
      registrar();
      const r = await responder(c);
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (p: unknown) => {
        c.op = 'insert';
        c.payload = p;
        return q;
      },
      update: (p: unknown) => {
        c.op = 'update';
        c.payload = p;
        return q;
      },
      delete: () => {
        c.op = 'delete';
        return q;
      },
      eq: (k: string, v: unknown) => {
        c.filtros[k] = v;
        return q;
      },
      gte: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: resolver,
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        resolver().then(ok, ko),
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, consultas };
}

const CUENTA = '00000000-0000-0000-0000-000000000001';
const SPEI_SECRET = 'spei-secreto';

function sesion(extra: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ses_1',
    account_id: CUENTA,
    flow_run_id: 'run_1',
    provider: 'spei',
    reference: 'pay_spei_1',
    amount: 99,
    currency: 'MXN',
    status: 'pending',
    contact_id: 'c_1',
    contact: { email: 'a@b.com' },
    ...extra,
  };
}

function speiFirmado(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const firma = createHmac('sha256', SPEI_SECRET).update(raw).digest('hex');
  return { raw, headers: new Headers({ 'x-spei-signature': firma }) };
}

/** Responder genérico para una sesión dada; `extra` cubre casos puntuales. */
function responderCon(
  ses: ReturnType<typeof sesion> | null,
  opts: {
    webhookSecret?: string | null;
    apiKey?: string | null;
    provider?: string;
    falloUpdateSesion?: boolean;
    eventosVistos?: Set<string>;
  } = {},
) {
  const vistos = opts.eventosVistos ?? new Set<string>();
  return (c: Consulta): Respuesta => {
    if (c.table === 'payment_gateway_configs') {
      return {
        data: {
          webhook_secret: opts.webhookSecret === undefined ? SPEI_SECRET : opts.webhookSecret,
          api_key: opts.apiKey ?? null,
        },
      };
    }
    if (c.table === 'payment_webhook_events') {
      const id = String((c.payload as { event_id?: string } | undefined)?.event_id ?? c.filtros.event_id);
      if (c.op === 'insert') {
        if (vistos.has(id)) return { error: { code: '23505', message: 'dup' } };
        vistos.add(id);
        return {};
      }
      if (c.op === 'delete') {
        vistos.delete(id);
        return {};
      }
    }
    if (c.table === 'flow_payment_sessions') {
      if (c.op === 'select') return { data: c.filtros.reference ? ses : [] };
      if (c.op === 'update') {
        if (opts.falloUpdateSesion) return { error: { message: 'db caída' } };
        const coincide = ses && c.filtros.status === ses.status;
        if (coincide) Object.assign(ses!, c.payload as object);
        return { data: coincide ? [{ id: ses!.id }] : [] };
      }
    }
    if (c.table === 'flow_runs') {
      return { data: c.op === 'select' ? { vars: {} } : null };
    }
    return {};
  };
}

const tocoRuns = (consultas: Consulta[]) => consultas.some((c) => c.table === 'flow_runs');

describe('procesarWebhookPago', () => {
  beforeEach(() => {
    vi.mocked(resumePaymentGateway).mockResolvedValue(true);
    vi.mocked(registrarVentaDeSesionAprobada).mockResolvedValue('sale_1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('SPEI sin secreto rechaza 401 aunque no traiga firma', async () => {
    const ses = sesion();
    const { db, consultas } = dbFalsa(responderCon(ses, { webhookSecret: null }));
    const r = await procesarWebhookPago({
      db,
      provider: 'spei',
      rawBody: JSON.stringify({ reference: 'pay_spei_1', status: 'pagado', amount: 99 }),
      headers: new Headers(),
      accountId: CUENTA,
    });
    expect(r.status).toBe(401);
    expect(consultas.some((c) => c.table === 'payment_webhook_events')).toBe(false);
    expect(ses.status).toBe('pending');
  });

  it('SPEI con secreto que no se puede descifrar rechaza 401', async () => {
    const { db } = dbFalsa(responderCon(sesion(), { webhookSecret: 'NO_DESCIFRA' }));
    const { raw, headers } = speiFirmado({ reference: 'pay_spei_1', status: 'pagado', amount: 99 });
    const r = await procesarWebhookPago({ db, provider: 'spei', rawBody: raw, headers, accountId: CUENTA });
    expect(r.status).toBe(401);
  });

  it('cualquier proveedor sin secreto rechaza 401', async () => {
    const { db } = dbFalsa(responderCon(null, { webhookSecret: null }));
    const r = await procesarWebhookPago({
      db,
      provider: 'hotmart',
      rawBody: '{}',
      headers: new Headers({ 'x-hotmart-hottok': '' }),
      accountId: CUENTA,
    });
    expect(r.status).toBe(401);
  });

  it('SPEI no concilia por correo + monto, solo por referencia', async () => {
    const ses = sesion();
    const { db, consultas } = dbFalsa((c) => {
      if (c.table === 'flow_payment_sessions' && c.op === 'select') {
        // Por referencia no hay nada; si buscara por correo encontraría la sesión.
        return { data: c.filtros.reference ? null : [ses] };
      }
      return responderCon(ses)(c);
    });
    const { raw, headers } = speiFirmado({ reference: 'otra_ref', status: 'pagado', amount: 99, email: 'a@b.com' });
    const r = await procesarWebhookPago({ db, provider: 'spei', rawBody: raw, headers, accountId: CUENTA });
    expect(r.body.ignored).toBe('session_not_found');
    expect(
      consultas.filter((c) => c.table === 'flow_payment_sessions' && c.op === 'select'),
    ).toHaveLength(1);
    expect(ses.status).toBe('pending');
  });

  it('Mercado Pago: el aviso approved no choca con el pending previo', async () => {
    const ses = sesion({ provider: 'mercadopago', reference: 'pay_mp_1' });
    const vistos = new Set<string>();
    const { db } = dbFalsa(
      responderCon(ses, { webhookSecret: 'mp_secret', apiKey: 'tok', eventosVistos: vistos }),
    );
    let estadoMp = 'pending';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 555,
            status: estadoMp,
            transaction_amount: 99,
            currency_id: 'MXN',
            external_reference: 'pay_mp_1',
          }),
          { status: 200 },
        ),
      ),
    );
    const aviso = () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const v1 = createHmac('sha256', 'mp_secret').update(`id:555;request-id:req;ts:${ts};`).digest('hex');
      return {
        rawBody: JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: '555' } }),
        headers: new Headers({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req' }),
      };
    };

    const r1 = await procesarWebhookPago({ db, provider: 'mercadopago', accountId: CUENTA, ...aviso() });
    expect(r1.body.pending).toBe(true);

    estadoMp = 'approved';
    const r2 = await procesarWebhookPago({ db, provider: 'mercadopago', accountId: CUENTA, ...aviso() });
    expect(r2.body.duplicate).toBeUndefined();
    expect(r2.body.status).toBe('approved');
    expect(ses.status).toBe('approved');
    expect(resumePaymentGateway).toHaveBeenCalledWith(db, {
      runId: 'run_1',
      decision: 'approved',
      sessionId: 'ses_1',
    });
    expect([...vistos]).toEqual([
      'payment:payment.updated:555:pending',
      'payment:payment.updated:555:approved',
    ]);
  });

  it('Mercado Pago: topics que no son payment se ignoran con 200', async () => {
    const { db } = dbFalsa(responderCon(null, { webhookSecret: 'mp_secret', apiKey: 'tok' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac('sha256', 'mp_secret').update(`id:77;ts:${ts};`).digest('hex');
    const r = await procesarWebhookPago({
      db,
      provider: 'mercadopago',
      rawBody: JSON.stringify({ topic: 'merchant_order', id: '77' }),
      headers: new Headers({ 'x-signature': `ts=${ts},v1=${v1}` }),
      accountId: CUENTA,
    });
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBe('topic_not_payment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reembolso sobre una sesión ya aprobada no toca la sesión ni la corrida', async () => {
    const ses = sesion({ status: 'approved' });
    const { db, consultas } = dbFalsa(responderCon(ses));
    const { raw, headers } = speiFirmado({ id: 'ev_2', reference: 'pay_spei_1', status: 'rechazado', amount: 99 });
    const r = await procesarWebhookPago({ db, provider: 'spei', rawBody: raw, headers, accountId: CUENTA });
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBe('session_closed');
    expect(ses.status).toBe('approved');
    expect(tocoRuns(consultas)).toBe(false);
    expect(consultas.some((c) => c.table === 'flow_payment_sessions' && c.op === 'update')).toBe(false);
    expect(resumePaymentGateway).not.toHaveBeenCalled();
    expect(registrarVentaDeSesionAprobada).not.toHaveBeenCalled();
  });

  it('approved sobre una sesión expired registra la venta sin reanudar la corrida', async () => {
    const ses = sesion({ status: 'expired' });
    const { db, consultas } = dbFalsa(responderCon(ses));
    const { raw, headers } = speiFirmado({ id: 'ev_3', reference: 'pay_spei_1', status: 'pagado', amount: 99 });
    const r = await procesarWebhookPago({ db, provider: 'spei', rawBody: raw, headers, accountId: CUENTA });
    expect(r.status).toBe(200);
    expect(r.body.late).toBe(true);
    expect(ses.status).toBe('approved');
    expect(registrarVentaDeSesionAprobada).toHaveBeenCalledWith(db, 'ses_1');
    expect(resumePaymentGateway).not.toHaveBeenCalled();
    expect(tocoRuns(consultas)).toBe(false);
  });

  it('approved sin monto se acepta por referencia y deja un aviso', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ses = sesion();
    const { db } = dbFalsa(responderCon(ses));
    const { raw, headers } = speiFirmado({ id: 'ev_4', reference: 'pay_spei_1', status: 'pagado' });
    const r = await procesarWebhookPago({ db, provider: 'spei', rawBody: raw, headers, accountId: CUENTA });
    expect(r.body.status).toBe('approved');
    expect(warn).toHaveBeenCalled();
  });

  it('si falla tras registrar el evento, lo libera para que el reintento funcione', async () => {
    const ses = sesion();
    const vistos = new Set<string>();
    const opts = { eventosVistos: vistos, falloUpdateSesion: true };
    const { db, consultas } = dbFalsa((c) => responderCon(ses, opts)(c));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = { id: 'ev_5', reference: 'pay_spei_1', status: 'pagado', amount: 99 };

    const intento1 = speiFirmado(body);
    await expect(
      procesarWebhookPago({ db, provider: 'spei', rawBody: intento1.raw, headers: intento1.headers, accountId: CUENTA }),
    ).rejects.toThrow('db caída');
    expect(consultas.some((c) => c.table === 'payment_webhook_events' && c.op === 'delete')).toBe(true);
    expect(vistos.size).toBe(0);

    // El proveedor reintenta y ya no se descarta como duplicado.
    opts.falloUpdateSesion = false;
    const intento2 = speiFirmado(body);
    const r = await procesarWebhookPago({
      db,
      provider: 'spei',
      rawBody: intento2.raw,
      headers: intento2.headers,
      accountId: CUENTA,
    });
    expect(r.body.duplicate).toBeUndefined();
    expect(r.body.status).toBe('approved');
  });
});

describe('urlBaseWebhook', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('usa NEXT_PUBLIC_SITE_URL si existe', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.ejemplo.mx/');
    expect(urlBaseWebhook(new Request('http://interno:8080/api/settings/payments'))).toBe(
      'https://crm.ejemplo.mx',
    );
  });

  it('sin la variable usa x-forwarded-host/proto del proxy', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const req = new Request('http://0.0.0.0:8080/api/settings/payments', {
      headers: { 'x-forwarded-host': 'crm.ejemplo.mx, otro', 'x-forwarded-proto': 'https' },
    });
    expect(urlBaseWebhook(req)).toBe('https://crm.ejemplo.mx');
  });

  it('fuerza https fuera de localhost y respeta http en local', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const publico = new Request('http://0.0.0.0:8080/x', {
      headers: { 'x-forwarded-host': 'crm.ejemplo.mx', 'x-forwarded-proto': 'http' },
    });
    expect(urlBaseWebhook(publico)).toBe('https://crm.ejemplo.mx');
    const local = new Request('http://localhost:3000/x', { headers: { host: 'localhost:3000' } });
    expect(urlBaseWebhook(local)).toBe('http://localhost:3000');
  });
});
