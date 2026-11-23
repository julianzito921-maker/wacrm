import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeTables } from '@/lib/flows/fake-db.test-helper';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const { createFakeDb } = await import('@/lib/flows/fake-db.test-helper');
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

import {
  leerAtribucion,
  reclamarCodigoDeEnlace,
  upsertContactAttribution,
} from './attribution';

beforeEach(() => {
  h.tables = {
    tracking_links: [
      {
        id: 'l1',
        account_id: 'a1',
        slug: 'promo',
        platform: 'meta',
        default_utm: { utm_campaign: 'def' },
        active: true,
      },
    ],
    tracking_clicks: [
      {
        id: 'c1',
        link_id: 'l1',
        account_id: 'a1',
        click_token: 'abc123',
        params: { utm_source: 'ig', fbclid: 'f1' },
        contact_id: null,
      },
    ],
    contact_attribution: [],
    custom_fields: [],
    contact_custom_values: [],
  };
});

describe('reclamarCodigoDeEnlace', () => {
  it('ata el clic al contacto, guarda la atribución y limpia el texto', async () => {
    const r = await reclamarCodigoDeEnlace({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct1',
      texto: 'Hola #abc123',
    });
    expect(r).toEqual({ texto: 'Hola' });

    expect(h.tables.tracking_clicks[0]).toMatchObject({
      contact_id: 'ct1',
    });
    const atribucion = h.tables.contact_attribution[0];
    expect(atribucion).toMatchObject({
      contact_id: 'ct1',
      source: 'meta',
      link_id: 'l1',
      click_id: 'c1',
      campaign: 'def',
    });
    expect(atribucion.utm).toMatchObject({ utm_source: 'ig', utm_campaign: 'def' });
    expect(atribucion.click_ids).toMatchObject({ fbclid: 'f1' });
    // Campo de compatibilidad para el inbox.
    console.log('VALORES', JSON.stringify(h.tables.contact_custom_values));
    expect(h.tables.contact_custom_values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contact_id: 'ct1', value: 'promo' }),
      ]),
    );
  });

  it('no vuelve a reclamar el mismo clic', async () => {
    await reclamarCodigoDeEnlace({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct1',
      texto: 'Hola #abc123',
    });
    const segundo = await reclamarCodigoDeEnlace({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct2',
      texto: 'Hola #abc123',
    });
    expect(segundo).toBeNull();
  });

  it('deja intacto un código desconocido', async () => {
    const r = await reclamarCodigoDeEnlace({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct1',
      texto: 'Color #ff0000',
    });
    expect(r).toBeNull();
    expect(h.tables.contact_attribution).toHaveLength(0);
  });
});

describe('upsertContactAttribution', () => {
  it('conserva first_seen y escribe los campos de compatibilidad', async () => {
    await upsertContactAttribution({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct1',
      source: 'meta',
      ctwaClid: 'clid-1',
      ad: 'ad-1',
    });
    const primera = h.tables.contact_attribution[0];
    const firstSeen = primera.first_seen_at as string;

    await new Promise((r) => setTimeout(r, 5));
    await upsertContactAttribution({
      accountId: 'a1',
      userId: 'u1',
      contactId: 'ct1',
      source: 'meta',
      ctwaClid: 'clid-2',
    });

    const fila = h.tables.contact_attribution[0];
    expect(h.tables.contact_attribution).toHaveLength(1);
    expect(fila.first_seen_at).toBe(firstSeen);
    expect(fila.ctwa_clid).toBe('clid-2');
    expect(h.tables.contact_custom_values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'clid-2' }),
        expect.objectContaining({ value: 'ad-1' }),
      ]),
    );
  });

  it('lee el ctwa_clid para CAPI', async () => {
    await upsertContactAttribution({
      accountId: 'a1',
      contactId: 'ct1',
      source: 'meta',
      ctwaClid: 'clid-9',
    });
    expect(await leerAtribucion('a1', 'ct1')).toEqual({ ctwa_clid: 'clid-9' });
    expect(await leerAtribucion('a1', 'otro')).toBeNull();
  });
});
