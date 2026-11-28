import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { leerClaveIntegracion } from '@/lib/integraciones/store';
import { ClienteLeona, LeonaError, separarCodigos } from '@/lib/flows/leona/cliente';
import { esFlujoLeona } from '@/lib/flows/leona/convertir';
import { guardarFlujoLeona, type ResultadoImportacion } from '@/lib/flows/leona/importar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_POR_VEZ = 20;

/** Lista los flujos de la cuenta de Leona (para elegirlos). */
export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const token = await leerClaveIntegracion(ctx.accountId, 'leona');
    if (!token) return NextResponse.json({ error: 'leona_not_configured' }, { status: 400 });
    const lista = await new ClienteLeona(token).listarFlujos(100);
    const flujos = (Array.isArray(lista) ? lista : ((lista as { flows?: unknown[] })?.flows ?? [])) as Array<
      Record<string, unknown>
    >;
    return NextResponse.json({
      flows: flujos.map((f) => ({
        id: String(f.id ?? ''),
        uuid: String(f.uuid ?? ''),
        name: String(f.name ?? ''),
        status: String(f.status ?? ''),
        updated_at: f.updated_at ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof LeonaError) {
      return NextResponse.json({ error: 'leona_error', detail: err.message }, { status: err.httpStatus });
    }
    return toErrorResponse(err);
  }
}

/**
 * Importa flujos de Leona como borradores:
 *   - `{ codes: "123, 456\n<uuid>" }`: los pide a Leona con la credencial
 *     guardada en Integraciones (igual que el «Importar» de Leona).
 *   - `{ leona_json: {...} }`: el JSON de un flujo de Leona (su get_flow).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => ({}))) as {
      codes?: string;
      leona_json?: unknown;
    };
    const db = supabaseAdmin();
    const creados: ResultadoImportacion[] = [];
    const errores: Array<{ code: string; error: string }> = [];

    if (body.leona_json !== undefined) {
      if (!esFlujoLeona(body.leona_json)) {
        return NextResponse.json({ error: 'not_leona_flow' }, { status: 400 });
      }
      creados.push(
        await guardarFlujoLeona(db, { accountId: ctx.accountId, userId: ctx.userId, leona: body.leona_json }),
      );
      return NextResponse.json({ created: creados, errors: errores }, { status: 201 });
    }

    const codigos = separarCodigos(String(body.codes ?? ''));
    if (codigos.length === 0) return NextResponse.json({ error: 'no_codes' }, { status: 400 });
    if (codigos.length > MAX_POR_VEZ) {
      return NextResponse.json({ error: 'too_many', max: MAX_POR_VEZ }, { status: 400 });
    }
    const token = await leerClaveIntegracion(ctx.accountId, 'leona');
    if (!token) return NextResponse.json({ error: 'leona_not_configured' }, { status: 400 });

    const cliente = new ClienteLeona(token);
    for (const codigo of codigos) {
      try {
        const leona = await cliente.obtenerFlujo(codigo);
        if (!esFlujoLeona(leona)) throw new LeonaError('Ese código no devolvió un flujo.', 404);
        creados.push(await guardarFlujoLeona(db, { accountId: ctx.accountId, userId: ctx.userId, leona }));
      } catch (err) {
        if (err instanceof LeonaError && err.httpStatus === 400) throw err;
        errores.push({ code: codigo, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return NextResponse.json({ created: creados, errors: errores }, { status: creados.length ? 201 : 400 });
  } catch (err) {
    if (err instanceof LeonaError) {
      return NextResponse.json({ error: 'leona_error', detail: err.message }, { status: err.httpStatus });
    }
    return toErrorResponse(err);
  }
}
