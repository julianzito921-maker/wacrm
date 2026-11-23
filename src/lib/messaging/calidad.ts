// ============================================================
// VIGILANCIA DE LA CALIDAD DEL NÚMERO — Fase 6b / 2026
//
// Consulta GET /{phone_number_id} por CADA conexión y actualiza:
//   - quality_rating
//   - whatsapp_business_manager_messaging_limit
//   - display_phone_number
//   - health_status / restriction_scope
//
// En RED ya no apaga toda la automatización: pausa los broadcasts de
// esa conexión y crea una notificación urgente. Las respuestas 1:1 y
// UTILITY siguen funcionando mientras Meta lo permita.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getPhoneNumberHealth } from "@/lib/whatsapp/meta-api";
import { parseQualityRating, type QualityRating } from "@/lib/whatsapp/phone-health";
import { diagnosticoNumero, retirarNumero } from "./retiro";
import {
  alertarSalud,
  pausarBroadcastsDeConexiones,
} from "@/lib/whatsapp/health-webhook";

/** Errores de Meta que dicen que el CRM perdió el acceso al número. */
export function esPerdidaDeAcceso(mensaje: string): boolean {
  return /"code":\s*(190|131031|200)\b|Application has been deleted|has been locked|banned/i.test(mensaje);
}

export interface ResultadoCalidad {
  cuenta: string;
  conexionId: string | null;
  calidad: QualityRating;
  limite: string | null;
  accion: "nada" | "avisar" | "pausar_broadcasts" | "retirado" | "sin_acceso";
}

/**
 * Revisa las conexiones conectadas y deja constancia de la calidad.
 * En RED pausa broadcasts de esa conexión; el servicio 1:1 no se toca.
 */
export async function revisarCalidadDeNumeros(
  accountId?: string,
): Promise<ResultadoCalidad[]> {
  const salida: ResultadoCalidad[] = [];
  try {
    const db = supabaseAdmin();
    let consulta = db
      .from("whatsapp_connections")
      .select(
        "id, account_id, phone_number_id, access_token, phone_number, display_phone_number, quality_rating, status",
      )
      .eq("status", "connected");
    if (accountId) consulta = consulta.eq("account_id", accountId);
    const { data } = await consulta;
    const filas =
      (data as Array<{
        id: string;
        account_id: string;
        phone_number_id: string;
        access_token: string;
        phone_number: string | null;
        display_phone_number: string | null;
        quality_rating: string | null;
      }> | null) ?? [];

    for (const fila of filas) {
      try {
        const info = await getPhoneNumberHealth({
          phoneNumberId: fila.phone_number_id,
          accessToken: decrypt(fila.access_token),
        });

        // Estado del número y del nombre: baneado → se retira solo;
        // nombre rechazado o número restringido → alerta crítica.
        const diag = diagnosticoNumero(info);
        for (const alerta of diag.alertas) {
          await alertarSalud(db, {
            accountId: fila.account_id,
            regla: alerta.regla,
            titulo: alerta.regla.replaceAll("_", " "),
            detalle: alerta.texto,
            severidad: alerta.severidad === "critical" ? "critical" : "warning",
            accion: diag.retirar ? "numero_retirado" : "avisar",
            metadata: {
              phone_number_id: fila.phone_number_id,
              estado: info.status ?? null,
              nombre: info.verified_name ?? null,
              estado_nombre: info.name_status ?? null,
            },
          });
        }
        if (diag.retirar) {
          await retirarNumero(fila.account_id, "Meta marcó el número como BANNED", info);
          await db
            .from("whatsapp_connections")
            .update({
              health_status: "blocked",
              restriction_scope: "all",
              health_reason: "Meta marcó el número como BANNED.",
              last_health_event_at: new Date().toISOString(),
              status: "disconnected",
            })
            .eq("id", fila.id);
          salida.push({
            cuenta: fila.account_id,
            conexionId: fila.id,
            calidad: "UNKNOWN",
            limite: null,
            accion: "retirado",
          });
          continue;
        }

        const calidad = parseQualityRating(info.quality_rating);
        const limite = info.whatsapp_business_manager_messaging_limit ?? null;
        const health =
          calidad === "RED"
            ? "restricted"
            : calidad === "YELLOW"
              ? "warning"
              : "healthy";
        await db
          .from("whatsapp_connections")
          .update({
            quality_rating: info.quality_rating ?? fila.quality_rating,
            whatsapp_business_manager_messaging_limit: limite,
            messaging_limit_updated_at: new Date().toISOString(),
            display_phone_number:
              info.display_phone_number ?? fila.display_phone_number,
            health_status: health,
            restriction_scope: calidad === "RED" ? "mass" : null,
            health_reason:
              calidad === "RED"
                ? "Calidad del número en RED."
                : calidad === "YELLOW"
                  ? "Calidad del número en amarillo."
                  : null,
            last_health_event_at: new Date().toISOString(),
          })
          .eq("id", fila.id);

        let accion: ResultadoCalidad["accion"] = "nada";
        if (calidad === "YELLOW") {
          accion = "avisar";
          await alertarSalud(db, {
            accountId: fila.account_id,
            regla: "calidad_numero_amarilla",
            titulo: "Calidad del número en amarillo",
            detalle: "Baja el ritmo de envíos para no llegar a RED.",
            severidad: "warning",
            metadata: { calidad, limite, phone_number_id: fila.phone_number_id },
          });
        }
        if (calidad === "RED") {
          accion = "pausar_broadcasts";
          const pausados = await pausarBroadcastsDeConexiones(db, {
            connectionIds: [fila.id],
            reason: `Calidad del número en RED (${fila.phone_number_id}).`,
          });
          await alertarSalud(db, {
            accountId: fila.account_id,
            regla: "calidad_numero",
            titulo: "Calidad del número en RED",
            detalle: `Broadcasts pausados: ${pausados}. No se apaga el servicio 1:1.`,
            metadata: { calidad, limite, phone_number_id: fila.phone_number_id },
          });
        }

        salida.push({
          cuenta: fila.account_id,
          conexionId: fila.id,
          calidad,
          limite,
          accion,
        });
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        console.error("[calidad] no se pudo revisar el número:", mensaje);
        if (esPerdidaDeAcceso(mensaje)) {
          await alertarSalud(db, {
            accountId: fila.account_id,
            regla: "numero_sin_acceso",
            titulo: "Sin acceso al número de WhatsApp",
            detalle: mensaje.slice(0, 500),
            metadata: { phone_number_id: fila.phone_number_id },
          });
          salida.push({
            cuenta: fila.account_id,
            conexionId: fila.id,
            calidad: "UNKNOWN",
            limite: null,
            accion: "sin_acceso",
          });
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
