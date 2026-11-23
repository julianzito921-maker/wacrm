import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * POST   /api/dashboard/sales   → venta manual
 * PATCH  /api/dashboard/sales   → editar una venta
 * DELETE /api/dashboard/sales?id=… → eliminar (solo admin)
 */

function fechaValida(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const contactId = String(body.contact_id ?? '').trim();
    const amount = Number(body.amount);
    if (!contactId) {
      return NextResponse.json({ error: 'missing_contact' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
    }

    const { data: contacto } = await ctx.supabase
      .from('contacts')
      .select('id, name, lead_number, phone')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contacto) {
      return NextResponse.json({ error: 'contact_not_found' }, { status: 404 });
    }

    const { data: cuenta } = await ctx.supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', ctx.accountId)
      .maybeSingle();
    const currency =
      typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)
        ? body.currency
        : ((cuenta?.default_currency as string | undefined) ?? 'USD');

    let productId: string | null = null;
    if (typeof body.product_id === 'string' && body.product_id.trim()) {
      const { data: producto } = await ctx.supabase
        .from('product_catalog')
        .select('id')
        .eq('id', body.product_id.trim())
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!producto) {
        return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
      }
      productId = producto.id as string;
    }

    let connectionId: string | null = null;
    let instanceId: string | null = null;
    const connectionInput =
      typeof body.connection_id === 'string'
        ? body.connection_id.trim()
        : typeof body.instance_id === 'string'
          ? body.instance_id.trim()
          : '';
    if (connectionInput) {
      const { data: conexion } = await ctx.supabase
        .from('whatsapp_connections')
        .select('id, phone_number_id')
        .eq('id', connectionInput)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!conexion) {
        return NextResponse.json({ error: 'instance_not_found' }, { status: 404 });
      }
      connectionId = conexion.id as string;
      const { data: legacy } = await ctx.supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('phone_number_id', conexion.phone_number_id as string)
        .maybeSingle();
      instanceId = (legacy?.id as string | undefined) ?? null;
    } else {
      const { data: conexion } = await ctx.supabase
        .from('whatsapp_connections')
        .select('id, phone_number_id')
        .eq('account_id', ctx.accountId)
        .eq('active', true)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      connectionId = (conexion?.id as string | undefined) ?? null;
      if (conexion?.phone_number_id) {
        const { data: legacy } = await ctx.supabase
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', ctx.accountId)
          .eq('phone_number_id', conexion.phone_number_id as string)
          .maybeSingle();
        instanceId = (legacy?.id as string | undefined) ?? null;
      }
      if (!connectionId) {
        const { data: legacy } = await ctx.supabase
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        instanceId = (legacy?.id as string | undefined) ?? null;
      }
    }

    const { data, error } = await ctx.supabase
      .from('sales')
      .insert({
        account_id: ctx.accountId,
        contact_id: contactId,
        product_id: productId,
        instance_id: instanceId,
        connection_id: connectionId,
        lead_number: (contacto.lead_number as number | null) ?? null,
        client_name: (contacto.name as string | null) ?? null,
        amount,
        currency,
        payment_id:
          typeof body.payment_id === 'string' && body.payment_id.trim()
            ? body.payment_id.trim()
            : null,
        meta_ref:
          typeof body.meta_ref === 'string' && body.meta_ref.trim()
            ? body.meta_ref.trim()
            : null,
        region:
          typeof body.region === 'string' && body.region.trim()
            ? body.region.trim()
            : null,
        status:
          body.status === 'pending' || body.status === 'refunded'
            ? body.status
            : 'confirmed',
        source: 'manual',
        sold_at: fechaValida(body.sold_at) ?? new Date().toISOString(),
        created_by: ctx.userId,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ sale: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
      }
      patch.amount = amount;
    }
    if (typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)) {
      patch.currency = body.currency;
    }
    for (const campo of ['payment_id', 'meta_ref', 'region'] as const) {
      if (typeof body[campo] === 'string' || body[campo] === null) {
        const valor = String(body[campo] ?? '').trim();
        patch[campo] = valor || null;
      }
    }
    if (body.status === 'confirmed' || body.status === 'pending' || body.status === 'refunded') {
      patch.status = body.status;
    }
    if (body.sold_at !== undefined) {
      const fecha = fechaValida(body.sold_at);
      if (fecha) patch.sold_at = fecha;
    }
    if (body.product_id === null) {
      patch.product_id = null;
    } else if (typeof body.product_id === 'string' && body.product_id.trim()) {
      const { data: producto } = await ctx.supabase
        .from('product_catalog')
        .select('id')
        .eq('id', body.product_id.trim())
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!producto) {
        return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
      }
      patch.product_id = producto.id;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from('sales')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ sale: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from('sales')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
