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

export interface ResultadoCalidad {
  cuenta: string;
  calidad: QualityRating;
  limite: string | null;
  accion: "nada" | "avisar" | "apagar";
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
        console.error(
          "[calidad] no se pudo revisar el número:",
          err instanceof Error ? err.message : err,
        );
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
