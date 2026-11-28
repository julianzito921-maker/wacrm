/**
 * LowTrack (https://lowtrack.com.br): seguimiento de ventas y envío
 * automático al Facebook CAPI, igual que la integración de Leona.
 *
 * Cada venta aprobada del CRM se manda a `POST /api/webhook` con el token
 * de «Integraciones → API Tokens» (Bearer). El `transaction_id` es el
 * mismo event_id que usa el Purchase de Meta, así una venta repetida
 * vuelve 409 en LowTrack y no se cuenta dos veces.
 *
 * Doc: https://lowtrack.com.br/docs/webhook. Nunca lanza.
 */
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { leerClaveIntegracion } from './store';

export const LOWTRACK_URL = 'https://lowtrack.com.br/api/webhook';

type Evento = 'sale.approved' | 'sale.pending' | 'sale.refunded';

interface Contacto {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface Atribucion {
  source?: string | null;
  campaign?: string | null;
  adset?: string | null;
  ad?: string | null;
  ctwa_clid?: string | null;
  utm?: Record<string, unknown> | null;
  click_ids?: Record<string, unknown> | null;
}

const texto = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Arma el cuerpo del webhook de LowTrack. Exportado para pruebas. */
export function armarVentaLowtrack(args: {
  event: Evento;
  transactionId: string;
  amount: number;
  currency: string;
  producto?: string | null;
  contacto?: Contacto | null;
  atribucion?: Atribucion | null;
}): Record<string, unknown> {
  const c = args.contacto ?? {};
  const a = args.atribucion ?? {};
  const utm = (a.utm ?? {}) as Record<string, unknown>;
  const clicks = (a.click_ids ?? {}) as Record<string, unknown>;
  const nombre = texto(c.name);
  const [primero, ...resto] = (nombre ?? '').split(/\s+/);

  const customer: Record<string, unknown> = {};
  if (nombre) {
    customer.name = nombre;
    customer.first_name = primero;
    if (resto.length) customer.last_name = resto.join(' ');
  }
  const tel = (c.phone ?? '').replace(/\D/g, '');
  if (tel) customer.phone = tel;
  if (texto(c.email)) customer.email = texto(c.email);

  const tracking: Record<string, unknown> = {};
  const fuente = texto(utm.utm_source) ?? texto(a.source);
  if (fuente) tracking.utm_source = fuente;
  for (const k of ['utm_medium', 'utm_content', 'utm_term'] as const) {
    if (texto(utm[k])) tracking[k] = texto(utm[k]);
  }
  const campana = texto(utm.utm_campaign) ?? texto(a.campaign);
  if (campana) tracking.utm_campaign = campana;
  if (texto(clicks.fbp)) tracking.fbp = texto(clicks.fbp);
  if (texto(clicks.fbc)) tracking.fbc = texto(clicks.fbc);

  const cuerpo: Record<string, unknown> = {
    event: args.event,
    transaction_id: args.transactionId,
    amount: Math.round(args.amount * 100) / 100,
    currency: (args.currency || 'MXN').toUpperCase(),
    metadata: {
      platform: 'wacrm',
      channel: 'whatsapp',
      ...(texto(a.ctwa_clid) ? { ctwa_clid: texto(a.ctwa_clid) } : {}),
      ...(texto(a.ad) ? { ad: texto(a.ad) } : {}),
      ...(texto(a.adset) ? { adset: texto(a.adset) } : {}),
    },
  };
  if (texto(args.producto)) {
    cuerpo.product = { id: texto(args.producto), name: texto(args.producto) };
  }
  if (Object.keys(customer).length) cuerpo.customer = customer;
  if (Object.keys(tracking).length) cuerpo.tracking = tracking;
  return cuerpo;
}

export type ResultadoLowtrack =
  | { enviado: true; capi: boolean }
  | { enviado: false; motivo: 'sin_token' | 'sin_monto' | 'duplicada' | 'rechazado' | 'error'; detalle?: string };

/**
 * Manda una venta a LowTrack si la cuenta tiene el token guardado en
 * Configuración → Integraciones. Sin token no hace nada.
 */
export async function enviarVentaLowtrack(args: {
  accountId: string;
  contactId?: string | null;
  transactionId: string;
  amount: number;
  currency: string;
  producto?: string | null;
  event?: Evento;
}): Promise<ResultadoLowtrack> {
  try {
    const token = await leerClaveIntegracion(args.accountId, 'lowtrack');
    if (!token) return { enviado: false, motivo: 'sin_token' };
    if (!(Number(args.amount) > 0)) return { enviado: false, motivo: 'sin_monto' };

    const db = supabaseAdmin();
    let contacto: Contacto | null = null;
    let atribucion: Atribucion | null = null;
    if (args.contactId) {
      const [{ data: c }, { data: a }] = await Promise.all([
        db
          .from('contacts')
          .select('name, phone, email')
          .eq('id', args.contactId)
          .eq('account_id', args.accountId)
          .maybeSingle(),
        db
          .from('contact_attribution')
          .select('source, campaign, adset, ad, ctwa_clid, utm, click_ids')
          .eq('contact_id', args.contactId)
          .eq('account_id', args.accountId)
          .maybeSingle(),
      ]);
      contacto = (c as Contacto | null) ?? null;
      atribucion = (a as Atribucion | null) ?? null;
    }

    const res = await fetch(LOWTRACK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        armarVentaLowtrack({
          event: args.event ?? 'sale.approved',
          transactionId: args.transactionId,
          amount: Number(args.amount),
          currency: args.currency,
          producto: args.producto,
          contacto,
          atribucion,
        }),
      ),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { capi_sent?: boolean; error?: string };
    if (res.status === 409) return { enviado: false, motivo: 'duplicada' };
    if (!res.ok) {
      console.warn('[lowtrack] rechazó la venta:', res.status, json.error ?? '');
      return { enviado: false, motivo: 'rechazado', detalle: `${res.status} ${json.error ?? ''}`.trim() };
    }
    return { enviado: true, capi: Boolean(json.capi_sent) };
  } catch (err) {
    console.error('[lowtrack] falló:', err instanceof Error ? err.message : err);
    return { enviado: false, motivo: 'error', detalle: err instanceof Error ? err.message : String(err) };
  }
}
