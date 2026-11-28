import type { SupabaseClient } from '@supabase/supabase-js';

import { convertirFlujoLeona, etiquetasDelFlujo, type LeonaFlujo } from './convertir';

export interface ResultadoImportacion {
  id: string;
  name: string;
  nodos: number;
  avisos: string[];
}

/**
 * Guarda un flujo de Leona como borrador del WaCRM: busca (o crea) sus
 * etiquetas por nombre, traduce los bloques y escribe flow + flow_nodes.
 * Si fallan los nodos, borra el flujo para no dejar uno vacío.
 */
export async function guardarFlujoLeona(
  db: SupabaseClient,
  args: { accountId: string; userId: string; leona: LeonaFlujo },
): Promise<ResultadoImportacion> {
  const nombres = etiquetasDelFlujo(args.leona);
  const tags = new Map<string, string>();
  if (nombres.length) {
    const { data } = await db.from('tags').select('id, name').eq('account_id', args.accountId);
    for (const t of (data ?? []) as Array<{ id: string; name: string }>) {
      tags.set(t.name.trim().toLowerCase(), t.id);
    }
    for (const nombre of nombres) {
      if (tags.has(nombre.toLowerCase())) continue;
      const { data: nueva } = await db
        .from('tags')
        .insert({ name: nombre, color: '#8b5cf6', account_id: args.accountId, user_id: args.userId })
        .select('id')
        .single();
      if (nueva) tags.set(nombre.toLowerCase(), (nueva as { id: string }).id);
    }
  }

  const flujo = convertirFlujoLeona(args.leona, {
    tagId: (n) => tags.get(n.trim().toLowerCase()) ?? null,
  });

  const { data: flow, error } = await db
    .from('flows')
    .insert({
      user_id: args.userId,
      account_id: args.accountId,
      name: flujo.name,
      description: flujo.description,
      status: 'draft',
      trigger_type: flujo.trigger_type,
      trigger_config: flujo.trigger_config,
      entry_node_id: flujo.entry_node_id,
    })
    .select('id, name')
    .single();
  if (error || !flow) throw new Error(error?.message ?? 'No se pudo crear el flujo.');
  const creado = flow as { id: string; name: string };

  const { error: errNodos } = await db.from('flow_nodes').insert(
    flujo.nodes.map((n) => ({ flow_id: creado.id, ...n })),
  );
  if (errNodos) {
    await db.from('flows').delete().eq('id', creado.id);
    throw new Error(errNodos.message);
  }
  return { id: creado.id, name: creado.name, nodos: flujo.nodes.length, avisos: flujo.avisos };
}
