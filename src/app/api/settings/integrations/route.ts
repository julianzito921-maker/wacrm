import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { errorDeClave, esProveedorIntegracion } from '@/lib/integraciones/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Configuración → Integraciones: lista lo conectado. Nunca devuelve claves. */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('account_integrations')
      .select('provider, name, updated_at')
      .eq('account_id', accountId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ integrations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (!esProveedorIntegracion(body.provider)) {
      return NextResponse.json({ error: 'invalid_provider' }, { status: 400 });
    }
    const provider = body.provider;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) || null : null;
    const clave = typeof body.secret === 'string' ? body.secret.trim() : '';

    const patch: Record<string, unknown> = {
      account_id: accountId,
      provider,
      name,
      updated_at: new Date().toISOString(),
    };
    if (clave) {
      const error = errorDeClave(provider, clave);
      if (error) return NextResponse.json({ error }, { status: 400 });
      patch.secret = encrypt(clave);
    } else {
      // Editar solo el nombre: la clave tiene que existir ya.
      const { data: actual } = await supabase
        .from('account_integrations')
        .select('provider')
        .eq('account_id', accountId)
        .eq('provider', provider)
        .maybeSingle();
      if (!actual) return NextResponse.json({ error: 'invalid_api_key' }, { status: 400 });
    }

    // Clave anterior (cifrada): sirve para saber qué conexiones la usaban.
    const { data: anterior } = await supabase
      .from('account_integrations')
      .select('secret')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .maybeSingle();
    const { error } = clave
      ? await supabase.from('account_integrations').upsert(patch, { onConflict: 'account_id,provider' })
      : await supabase
          .from('account_integrations')
          .update({ name, updated_at: patch.updated_at })
          .eq('account_id', accountId)
          .eq('provider', provider);
    if (error) throw new Error(error.message);

    // Las islas D-API que usaban la clave de la cuenta toman la nueva al
    // instante. Las conectadas con la API Key de su instancia no se tocan.
    if (provider === 'dapi' && patch.secret && anterior?.secret) {
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ access_token: patch.secret })
        .eq('account_id', accountId)
        .eq('provider', 'dapi')
        .eq('access_token', (anterior as { secret: string }).secret);
    }
    // El agente de IA que ya apunta a OpenRouter toma la clave nueva.
    if (provider === 'openrouter' && patch.secret) {
      await supabaseAdmin()
        .from('ai_configs')
        .update({ api_key: patch.secret })
        .eq('account_id', accountId)
        .eq('provider', 'openai_compatible')
        .ilike('base_url', '%openrouter.ai%');
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const provider = new URL(request.url).searchParams.get('provider');
    if (!esProveedorIntegracion(provider)) {
      return NextResponse.json({ error: 'invalid_provider' }, { status: 400 });
    }
    const { error } = await supabase
      .from('account_integrations')
      .delete()
      .eq('account_id', accountId)
      .eq('provider', provider);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
