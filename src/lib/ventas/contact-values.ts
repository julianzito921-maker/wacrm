import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Valores de campos personalizados del contacto. Vive aparte de
 * `conversiones.ts` para que la atribución (que también escribe
 * ctwa_clid y anuncio_id) no cree un ciclo de imports.
 */

export async function campoId(
  accountId: string,
  userId: string,
  nombre: string,
): Promise<string | null> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', nombre)
    .maybeSingle()
  if (data) return data.id as string
  const { data: nuevo } = await db
    .from('custom_fields')
    .insert({ account_id: accountId, user_id: userId, field_name: nombre, field_type: 'text' })
    .select('id')
    .single()
  return (nuevo?.id as string | undefined) ?? null
}

export async function guardarValor(
  accountId: string,
  userId: string,
  contactId: string,
  nombre: string,
  valor: string,
): Promise<void> {
  const id = await campoId(accountId, userId, nombre)
  if (!id) return
  await supabaseAdmin()
    .from('contact_custom_values')
    .upsert(
      { contact_id: contactId, custom_field_id: id, value: valor },
      { onConflict: 'contact_id,custom_field_id' },
    )
}

export async function leerValores(
  accountId: string,
  contactId: string,
): Promise<Record<string, string>> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('contact_custom_values')
    .select('value, custom_fields!inner(field_name, account_id)')
    .eq('contact_id', contactId)
    .eq('custom_fields.account_id', accountId)
  const out: Record<string, string> = {}
  for (const f of (data ?? []) as unknown as {
    value: string
    custom_fields: { field_name: string }
  }[]) {
    out[f.custom_fields.field_name] = f.value
  }
  return out
}
