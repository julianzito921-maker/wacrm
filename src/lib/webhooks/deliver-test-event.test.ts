import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => {
    if (s === 'roto') throw new Error('bad ciphertext');
    return s;
  },
  encrypt: (s: string) => s,
}));

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { sendTestDelivery, TEST_EVENT } from './deliver';
import { isDeliverableUrl } from './ssrf';
import { verifySignatureHeader } from './sign';

const ROW = { id: 'wh-1', url: 'https://a.test/hook', secret: 'whsec_x' };
const NOW = new Date('2026-11-24T12:00:00Z');

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('sendTestDelivery', () => {
  it('manda webhook.test firmado, sin seguir redirecciones, y reporta el código', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const r = await sendTestDelivery(ROW, 'acct-1', NOW);

    expect(r).toMatchObject({ ok: true, status: 204 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(ROW.url);
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Event']).toBe(TEST_EVENT);
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('webhook.test');
    expect(body.account_id).toBe('acct-1');
    // La firma la puede verificar el receptor con el mismo secreto.
    expect(
      verifySignatureHeader(
        opts.headers['X-Wacrm-Signature'],
        opts.body,
        ROW.secret,
        Math.floor(NOW.getTime() / 1000)
      )
    ).toBe(true);
  });

  it('un 500 del receptor se reporta como http, sin lanzar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    const r = await sendTestDelivery(ROW, 'acct-1', NOW);
    expect(r).toMatchObject({ ok: false, reason: 'http', status: 500 });
  });

  it('una URL privada no se llama', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const r = await sendTestDelivery(ROW, 'acct-1', NOW);
    expect(r).toMatchObject({ ok: false, reason: 'blocked_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('secreto ilegible → reason secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendTestDelivery({ ...ROW, secret: 'roto' }, 'acct-1', NOW);
    expect(r).toMatchObject({ ok: false, reason: 'secret' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caída de red o tiempo agotado → reason network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const r = await sendTestDelivery(ROW, 'acct-1', NOW);
    expect(r).toMatchObject({ ok: false, reason: 'network' });
  });
});
