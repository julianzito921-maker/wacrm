import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CAMPOS_CONEXION_PUBLICOS } from '@/lib/whatsapp/connections';
import {
  emparejarConexionEnMeta,
  pinValido,
  type ResultadoEmparejar,
} from '@/lib/whatsapp/conexion-meta';
import { borrarSesion, esDapi, sesionDe } from '@/lib/whatsapp/dapi';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.waba_id === 'string') patch.waba_id = body.waba_id.trim() || null;
    if (typeof body.badge_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.badge_color)) {
      patch.badge_color = body.badge_color;
    }
    if (typeof body.access_token === 'string' && body.access_token.trim()) {
      patch.access_token = encrypt(body.access_token.trim());
    }
    if (typeof body.verify_token === 'string') {
      patch.verify_token = body.verify_token.trim()
        ? encrypt(body.verify_token.trim())
        : null;
    }
    if (typeof body.app_secret === 'string') {
      patch.app_secret = body.app_secret.trim()
        ? encrypt(body.app_secret.trim())
        : null;
    }
    if (typeof body.status === 'string' && ['connected', 'disconnected'].includes(body.status)) {
      patch.status = body.status;
    }
    if (typeof body.warmup_enabled === 'boolean') {
      patch.warmup_enabled = body.warmup_enabled;
    }
    if (typeof body.active === 'boolean') {
      patch.active = body.active;
    }
    if (typeof body.custom_domain === 'string') {
      const limpio = body.custom_domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/\.$/, '');
      if (limpio && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(limpio)) {
        return NextResponse.json({ error: 'invalid_domain' }, { status: 400 });
      }
      patch.custom_domain = limpio || null;
    }
    if (typeof body.tracking_pixel_id === 'string') {
      const pixelId = body.tracking_pixel_id.trim() || null;
      if (pixelId) {
        const { data: pixel } = await ctx.supabase
          .from('tracking_pixels')
          .select('id')
          .eq('id', pixelId)
          .eq('account_id', ctx.accountId)
          .eq('platform', 'meta')
          .maybeSingle();
        if (!pixel) {
          return NextResponse.json({ error: 'invalid_pixel' }, { status: 400 });
        }
      }
      patch.tracking_pixel_id = pixelId;
    }
    if (body.is_default === true) {
      // El default anterior se apaga justo antes de guardar (más abajo),
      // para no dejar la cuenta sin default si Meta rechaza el cambio.
      patch.is_default = true;
    } else if (body.is_default === false) {
      patch.is_default = false;
    }
    const pinRaw = body.pin;
    const pin = pinRaw === undefined || pinRaw === null || pinRaw === '' ? null : pinRaw;
    if (pin !== null && !pinValido(pin)) {
      return NextResponse.json({ error: 'invalid_pin' }, { status: 400 });
    }
    if (Object.keys(patch).length === 0 && pin === null) {
      return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });
    }

    // Token o WABA nuevos (o PIN): hay que volver a suscribir la WABA a la
    // app y, con PIN, registrar el número — igual que la ruta legada. Sin
    // esto, cambiar de WABA dejaba la isla sin webhooks entrantes.
    let emparejado: ResultadoEmparejar | null = null;
    const cambiaToken = typeof body.access_token === 'string' && body.access_token.trim() !== '';
    // La pantalla de conexiones manda waba_id en CADA guardado (también al
    // renombrar o cambiar el dominio): solo cuenta como cambio si difiere
    // del guardado, para que un fallo de Meta no bloquee ediciones inocuas.
    let fila: { phone_number_id: string; waba_id: string | null; access_token: string } | null =
      null;
    if (cambiaToken || 'waba_id' in patch || pin !== null) {
      const { data: actual, error: errActual } = await supabaseAdmin()
        .from('whatsapp_connections')
        .select('phone_number_id, waba_id, access_token')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (errActual) throw new Error(errActual.message);
      if (!actual) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      fila = actual as { phone_number_id: string; waba_id: string | null; access_token: string };
    }
    const cambiaWaba =
      !!fila && 'waba_id' in patch && (patch.waba_id ?? null) !== (fila.waba_id ?? null);
    if (fila && (cambiaToken || cambiaWaba || pin !== null)) {

      let accessToken: string;
      if (cambiaToken) {
        accessToken = (body.access_token as string).trim();
      } else {
        try {
          accessToken = decrypt(fila.access_token);
        } catch {
          // Token guardado ilegible (ENCRYPTION_KEY distinta): hay que
          // volver a pegarlo para poder suscribir la WABA.
          return NextResponse.json({ error: 'token_unreadable' }, { status: 400 });
        }
      }
      const wabaId = cambiaWaba ? (patch.waba_id as string | null) : fila.waba_id;

      emparejado = await emparejarConexionEnMeta({
        phoneNumberId: fila.phone_number_id,
        wabaId,
        accessToken,
        pin: pin as string | null,
      });
      if (!emparejado.ok) {
        return NextResponse.json(
          { error: 'meta_error', detail: emparejado.error, meta: emparejado.meta },
          { status: emparejado.httpStatus },
        );
      }
      if (emparejado.errorRegistro) {
        patch.status = 'disconnected';
      } else if (emparejado.registrada && patch.status === undefined) {
        patch.status = 'connected';
      }
      patch.last_synced_at = new Date().toISOString();
    }

    if (patch.is_default === true) {
      await supabaseAdmin()
        .from('whatsapp_connections')
        .update({ is_default: false })
        .eq('account_id', ctx.accountId)
        .eq('is_default', true)
        .neq('id', id);
    }

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CAMPOS_CONEXION_PUBLICOS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (emparejado?.ok) {
      return NextResponse.json({
        connection: data,
        waba_subscribed: emparejado.suscrita,
        registered: emparejado.registrada,
        ...(emparejado.errorRegistro
          ? {
              warning: 'registration_failed',
              registration_error: emparejado.errorRegistro,
              meta: emparejado.metaRegistro,
            }
          : {}),
      });
    }
    return NextResponse.json({ connection: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    // Isla D-API: también se cierra la sesión en D-API (deja de cobrar y
    // de mandar avisos). Si D-API falla, se borra igual aquí.
    const { data: previa } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('phone_number_id, access_token')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (previa && esDapi(previa.phone_number_id as string)) {
      try {
        await borrarSesion({
          apiKey: decrypt(previa.access_token as string),
          sessionId: sesionDe(previa.phone_number_id as string),
        });
      } catch (err) {
        console.warn(
          '[connections] no se pudo borrar la sesión en D-API:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_connections')
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
