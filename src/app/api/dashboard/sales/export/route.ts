import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

const HEADERS: Record<string, string[]> = {
  es: ['Instancia', 'Nº instancia', 'Nº lead', 'Cliente', 'Producto', 'ID', 'Valor', 'Meta', 'Payment ID', 'Fecha', 'Estado/UF'],
  en: ['Instance', 'Instance no.', 'Lead no.', 'Customer', 'Product', 'ID', 'Value', 'Meta', 'Payment ID', 'Date', 'State/UF'],
  pt: ['Instância', 'Nº instância', 'Nº lead', 'Cliente', 'Produto', 'ID', 'Valor', 'Meta', 'Payment ID', 'Data', 'Estado/UF'],
  ko: ['인스턴스', '인스턴스 번호', '리드 번호', '고객', '제품', 'ID', '금액', 'Meta', 'Payment ID', '날짜', '주/지역'],
};

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) {
      return NextResponse.json({ error: 'missing_range' }, { status: 400 });
    }
    const locale = (url.searchParams.get('locale') || 'es').slice(0, 2);

    let query = supabase
      .from('sales')
      .select(
        'id, client_name, amount, currency, payment_id, meta_ref, region, status, sold_at, lead_number, product_id, instance_id, contacts(name, lead_number), product_catalog(nombre), whatsapp_config(phone_number_id)',
      )
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .gte('sold_at', from)
      .lt('sold_at', to)
      .order('sold_at', { ascending: false })
      .limit(5000);

    const instance = url.searchParams.get('instance');
    const product = url.searchParams.get('product');
    const agent = url.searchParams.get('agent');
    const currency = url.searchParams.get('currency');
    if (instance) query = query.eq('instance_id', instance);
    if (product) query = query.eq('product_id', product);
    if (agent) query = query.eq('created_by', agent);
    if (currency) query = query.eq('currency', currency);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const head = HEADERS[locale] ?? HEADERS.es;
    const lines = [head.map(csvCell).join(',')];
    for (const s of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const contact = s.contacts as { name?: string; lead_number?: number } | null;
      const productRow = s.product_catalog as { nombre?: string } | null;
      const conn = s.whatsapp_config as { phone_number_id?: string } | null;
      lines.push(
        [
          conn?.phone_number_id
            ? `WhatsApp ${String(conn.phone_number_id).slice(-4)}`
            : 'Sin conexión',
          conn?.phone_number_id ?? '',
          s.lead_number ?? contact?.lead_number ?? '',
          s.client_name ?? contact?.name ?? '',
          productRow?.nombre ?? 'Sin producto',
          s.id,
          s.amount,
          s.meta_ref ?? '',
          s.payment_id ?? '',
          s.sold_at ? new Date(String(s.sold_at)).toISOString() : '',
          s.region ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const csv = `\uFEFF${lines.join('\r\n')}`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="ventas-${new Date().toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
