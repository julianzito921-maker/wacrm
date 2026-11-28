/**
 * Variables globales (Configuración → Variables globales): se suman a las
 * variables de la corrida para que los textos usen {{vars.nombre}}. Una
 * variable del propio flujo con el mismo nombre manda. Nunca lanza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function sumarVariablesGlobales(
  db: SupabaseClient,
  run: { account_id: string; vars: Record<string, unknown> | null },
): Promise<void> {
  try {
    const { data } = await db
      .from("account_variables")
      .select("key, value")
      .eq("account_id", run.account_id);
    if (!Array.isArray(data) || data.length === 0) return;
    if (!run.vars || typeof run.vars !== "object") run.vars = {};
    for (const v of data as Array<{ key: string; value: string }>) {
      if (!(v.key in run.vars)) run.vars[v.key] = v.value;
    }
  } catch {
    // Sin tabla (aún sin migrar) o sin red: el flujo sigue sin globales.
  }
}
