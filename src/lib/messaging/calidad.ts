// ============================================================
// VIGILANCIA DE LA CALIDAD DEL NÚMERO — Fase 6b
//
// Es lo único que Meta publica sobre «cómo va tu número»: la
// calificación (verde, amarilla, roja) y el límite de mensajería del
// día. Si baja, es el aviso previo a una restricción.
//
// Esta pieza la revisa sola (desde el cron de mensajería) y actúa:
//   - amarilla  → avisa (alertas) para que bajemos el ritmo;
//   - roja      → avisa Y APAGA la automatización (§23), para no
//                 seguir mandando con el número en riesgo.
//
// Nunca lanza: si Meta no contesta, no se toca nada.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getPhoneNumberHealth } from "@/lib/whatsapp/meta-api";
import { parseQualityRating, type QualityRating } from "@/lib/whatsapp/phone-health";
import { fijarInterruptor } from "./interruptor";
import { diagnosticoNumero, retirarNumero } from "./retiro";

type Db = ReturnType<typeof supabaseAdmin>;

/** ¿Ya hay una alerta igual de esta cuenta en las últimas 24 h? (para no repetirla cada 10 min) */
async function alertaReciente(db: Db, accountId: string, regla: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("messaging_alerts")
      .select("id")
      .eq("account_id", accountId)
      .eq("regla", regla)
      .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Errores de Meta que dicen que el CRM perdió el acceso al número (app borrada, token muerto, WABA bloqueada). */
export function esPerdidaDeAcceso(mensaje: string): boolean {
  return /"code":\s*(190|131031|200)\b|Application has been deleted|has been locked|banned/i.test(mensaje);
}

export interface ResultadoCalidad {
  cuenta: string;
  calidad: QualityRating;
  limite: string | null;
  accion: "nada" | "avisar" | "apagar" | "retirado" | "sin_acceso";
}

/**
 * Revisa los números conectados y deja constancia de la calidad. Si está
 * en rojo, apaga la automatización de esa cuenta.
 */
export async function revisarCalidadDeNumeros(
  accountId?: string,
): Promise<ResultadoCalidad[]> {
  const salida: ResultadoCalidad[] = [];
  try {
    const db = supabaseAdmin();
    let consulta = db
      .from("whatsapp_config")
      .select("account_id, phone_number_id, access_token, status")
      .eq("status", "connected");
    if (accountId) consulta = consulta.eq("account_id", accountId);
    const { data } = await consulta;
    const filas =
      (data as Array<{
        account_id: string;
        phone_number_id: string;
        access_token: string;
      }> | null) ?? [];

    for (const fila of filas) {
      try {
        const info = await getPhoneNumberHealth({
          phoneNumberId: fila.phone_number_id,
          accessToken: decrypt(fila.access_token),
        });
        // Estado del número y del nombre: baneado → se retira solo; nombre
        // rechazado o número restringido → alerta crítica (una vez al día).
        const diag = diagnosticoNumero(info);
        for (const alerta of diag.alertas) {
          if (await alertaReciente(db, fila.account_id, alerta.regla)) continue;
          await db.from("messaging_alerts").insert({
            account_id: fila.account_id,
            regla: alerta.regla,
            severidad: alerta.severidad,
            detalle: {
              texto: alerta.texto,
              phone_number_id: fila.phone_number_id,
              estado: info.status ?? null,
              nombre: info.verified_name ?? null,
              estado_nombre: info.name_status ?? null,
            } as never,
            accion: diag.retirar ? "numero_retirado" : "avisar",
          });
        }
        if (diag.retirar) {
          await retirarNumero(fila.account_id, "Meta marcó el número como BANNED", info);
          salida.push({ cuenta: fila.account_id, calidad: "UNKNOWN", limite: null, accion: "retirado" });
          continue;
        }

        const calidad = parseQualityRating(info.quality_rating);
        const limite =
          info.whatsapp_business_manager_messaging_limit ?? null;

        let accion: ResultadoCalidad["accion"] = "nada";
        if (calidad === "YELLOW") accion = "avisar";
        if (calidad === "RED") {
          accion = "apagar";
          await fijarInterruptor(
            false,
            `Calidad del número en rojo (${fila.phone_number_id}). Automatización detenida sola.`,
          );
        }

        if (accion !== "nada") {
          await db.from("messaging_alerts").insert({
            account_id: fila.account_id,
            regla: "calidad_numero",
            severidad: calidad === "RED" ? "critical" : "warning",
            detalle: {
              calidad,
              limite,
              phone_number_id: fila.phone_number_id,
            } as never,
            accion: accion === "apagar" ? "automatizacion_apagada" : "avisar",
          });
        }

        salida.push({
          cuenta: fila.account_id,
          calidad,
          limite,
          accion,
        });
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        console.error("[calidad] no se pudo revisar el número:", mensaje);
        // Sin acceso (app borrada, token muerto, WABA bloqueada): se avisa,
        // pero NO se retira solo: puede ser un token mal pegado.
        if (esPerdidaDeAcceso(mensaje) && !(await alertaReciente(db, fila.account_id, "numero_sin_acceso"))) {
          await db.from("messaging_alerts").insert({
            account_id: fila.account_id,
            regla: "numero_sin_acceso",
            severidad: "critical",
            detalle: { phone_number_id: fila.phone_number_id, error: mensaje.slice(0, 500) } as never,
            accion: "avisar",
          });
          salida.push({ cuenta: fila.account_id, calidad: "UNKNOWN", limite: null, accion: "sin_acceso" });
        }
      }
    }
  } catch (err) {
    console.error(
      "[calidad] revisión fallida:",
      err instanceof Error ? err.message : err,
    );
  }
  return salida;
}
