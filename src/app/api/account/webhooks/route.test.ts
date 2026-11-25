import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  count: 0,
  inserted: [] as Record<string, unknown>[],
  deliverable: true,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => {
    throw new Error('not used');
  },
  requireRole: async () => ({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
    supabase: {
      from: () => ({
        select: () => ({
          eq: async () => ({ count: h.count, error: null }),
        }),
        insert: (row: Record<string, unknown>) => {
          h.inserted.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: 'wh-1',
                  url: row.url,
                  events: row.events,
                  is_active: true,
                  last_delivery_at: null,
                  failure_count: 0,
                  created_at: '2026-11-24T00:00:00Z',
                },
                error: null,
              }),
            }),
          };
        },
      }),
    },
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v,
}));

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: async () => h.deliverable,
}));

import { POST } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

function post(body: unknown) {
  return POST(
    new Request('http://t/api/account/webhooks', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<{ status: number; body: Record<string, unknown> }>;
}

beforeEach(() => {
  h.count = 0;
  h.inserted = [];
  h.deliverable = true;
  __resetRateLimitForTests();
});

describe('POST /api/account/webhooks', () => {
  it('crea el webhook, guarda el secreto cifrado y lo devuelve una vez', async () => {
    const res = await post({
      url: 'https://hook.example.com/x',
      events: ['message.received', 'message.received'],
    });
    expect(res.status).toBe(201);
    const secret = res.body.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(h.inserted[0].secret).toBe(`enc:${secret}`);
    expect(h.inserted[0].events).toEqual(['message.received']);
    expect(h.inserted[0].account_id).toBe('acc-1');
    // La respuesta pública no trae el secreto dentro del webhook.
    expect((res.body.webhook as Record<string, unknown>).secret).toBeUndefined();
  });

  it('rechaza http:// y URLs con usuario', async () => {
    expect((await post({ url: 'http://a.com', events: ['message.received'] })).status).toBe(400);
    expect(
      (await post({ url: 'https://u:p@a.com', events: ['message.received'] })).status
    ).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });

  it('rechaza una URL que resuelve a una dirección privada', async () => {
    h.deliverable = false;
    const res = await post({ url: 'https://interno.test', events: ['message.received'] });
    expect(res.status).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });

  it('rechaza eventos vacíos o desconocidos', async () => {
    expect((await post({ url: 'https://a.com', events: [] })).status).toBe(400);
    expect((await post({ url: 'https://a.com', events: ['nope'] })).status).toBe(400);
  });

  it('respeta el tope por cuenta', async () => {
    h.count = 10;
    const res = await post({ url: 'https://a.com', events: ['message.received'] });
    expect(res.status).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });
});
