// ============================================================
// RETIRO DE UN NÚMERO BANEADO — 18-nov-2026
//
// Cuando Meta banea un número, nada de lo que el CRM tenga ligado a él
// debe seguir vivo: ni esperas, ni cola, ni flujos, ni automatizaciones,
// ni las plantillas de esa WABA. Y la conexión (whatsapp_config) se
// borra para que la cuenta pueda conectar un número NUEVO y legítimo.
//
// Lo que NO se borra aquí: contactos, conversaciones y mensajes. Son el
// historial de ventas; borrarlos es otra decisión (script aparte, con
// respaldo).
//
// Antes de borrar se deja una ficha del número en `messaging_alerts`
// (regla «numero_retirado») para poder apelar en Meta o reconectarlo.
//
// Los flujos y automatizaciones quedan APAGADOS, no borrados: el embudo
// que estaba corriendo cuando llegó el baneo es sospechoso y se revisa
// antes de volver a encenderlo con el número nuevo.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";

export interface EstadoNumero {
  status?: string | null;
  name_status?: string | null;
  verified_name?: string | null;
  display_phone_number?: string | null;
}

export interface AlertaNumero {
  regla: "numero_baneado" | "numero_restringido" | "nombre_rechazado";
  severidad: "warning" | "critical";
  texto: string;
}

const NOMBRE_RECHAZADO = new Set(["DECLINED", "REJECTED", "NON_EXISTS"]);

/** Lee el estado que da Meta y dice qué alertas tocan y si hay que retirar el número. */
export function diagnosticoNumero(info: EstadoNumero): {
  retirar: boolean;
  alertas: AlertaNumero[];
} {
  const estado = (info.status ?? "").toUpperCase();
  const nombre = (info.name_status ?? "").toUpperCase();
  const alertas: AlertaNumero[] = [];

  if (estado === "BANNED") {
    alertas.push({
      regla: "numero_baneado",
      severidad: "critical",
      texto: `Meta baneó el número ${info.display_phone_number ?? ""}. Se retira del CRM; apelar en Business Support Home.`,
    });
  } else if (estado === "RESTRICTED" || estado === "FLAGGED") {
    alertas.push({
      regla: "numero_restringido",
      severidad: "critical",
      texto: `El número ${info.display_phone_number ?? ""} está ${estado} en Meta. Bajar el ritmo y revisar el embudo.`,
    });
  }

  if (NOMBRE_RECHAZADO.has(nombre)) {
    alertas.push({
      regla: "nombre_rechazado",
      severidad: "critical",
      texto: `Meta rechazó el nombre visible «${info.verified_name ?? ""}» (${nombre}). Cambiarlo en WhatsApp Manager por uno que coincida con la marca y su sitio web.`,
    });
  }

  return { retirar: estado === "BANNED", alertas };
}

export interface ResumenRetiro {
  cuenta: string;
  phoneNumberId: string | null;
  esperasCanceladas: number;
  colaCancelada: number;
  corridasCanceladas: number;
  flujosApagados: number;
  automatizacionesApagadas: number;
  plantillasBorradas: number;
  conexionBorrada: boolean;
  errores: string[];
}

/**
 * Retira el número conectado a la cuenta. Nunca lanza: cada paso se
 * intenta por separado y los fallos quedan en `errores`.
 */
export async function retirarNumero(
  accountId: string,
  motivo: string,
  info: EstadoNumero = {},
): Promise<ResumenRetiro> {
  const db = supabaseAdmin();
  const r: ResumenRetiro = {
    cuenta: accountId,
    phoneNumberId: null,
    esperasCanceladas: 0,
    colaCancelada: 0,
    corridasCanceladas: 0,
    flujosApagados: 0,
    automatizacionesApagadas: 0,
    plantillasBorradas: 0,
    conexionBorrada: false,
    errores: [],
  };
  const paso = async (nombre: string, fn: () => Promise<number | void>) => {
    try {
      return await fn();
    } catch (err) {
      r.errores.push(`${nombre}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  };
  const contar = (data: unknown) => (Array.isArray(data) ? data.length : 0);

  // 0) Ficha del número antes de borrar nada.
  const { data: conf } = await db
    .from("whatsapp_config")
    .select("id, phone_number_id, waba_id, connected_at")
    .eq("account_id", accountId)
    .maybeSingle();
  const config = conf as {
    id: string;
    phone_number_id: string;
    waba_id: string | null;
    connected_at: string | null;
  } | null;
  r.phoneNumberId = config?.phone_number_id ?? null;

  await paso("ficha", async () => {
    await db.from("messaging_alerts").insert({
      account_id: accountId,
      regla: "numero_retirado",
      severidad: "critical",
      detalle: {
        motivo,
        phone_number_id: config?.phone_number_id ?? null,
        waba_id: config?.waba_id ?? null,
        conectado_desde: config?.connected_at ?? null,
        numero: info.display_phone_number ?? null,
        nombre: info.verified_name ?? null,
        estado_meta: info.status ?? null,
        estado_nombre: info.name_status ?? null,
      } as never,
      accion: "numero_retirado",
    });
  });

  // 1) Esperas de automatizaciones.
  r.esperasCanceladas = (await paso("esperas", async () => {
    const { data, error } = await db
      .from("automation_pending_executions")
      .update({ status: "expired" })
      .eq("account_id", accountId)
      .in("status", ["pending", "awaiting_reply"])
      .select("id");
    if (error) throw new Error(error.message);
    return contar(data);
  })) as number;

  // 2) Cola de salida.
  r.colaCancelada = (await paso("cola", async () => {
    const { data, error } = await db
      .from("outbound_message_queue")
      .update({ status: "CANCELLED", cancel_reason: `numero_retirado: ${motivo}` })
      .eq("account_id", accountId)
      .in("status", ["PENDING"])
      .select("id");
    if (error) throw new Error(error.message);
    return contar(data);
  })) as number;

  // 3) Flujos: cortar corridas y apagar (a borrador, no se borran).
  const { data: flujos } = await db
    .from("flows")
    .select("id, status")
    .eq("account_id", accountId);
  const idsFlujos = ((flujos as Array<{ id: string; status: string }> | null) ?? []).map((f) => f.id);
  if (idsFlujos.length) {
    r.corridasCanceladas = (await paso("corridas", async () => {
      const { data, error } = await db
        .from("flow_runs")
        .update({ status: "cancelled" })
        .in("flow_id", idsFlujos)
        .eq("status", "active")
        .select("id");
      if (error) throw new Error(error.message);
      return contar(data);
    })) as number;
    r.flujosApagados = (await paso("flujos", async () => {
      const { data, error } = await db
        .from("flows")
        .update({ status: "draft" })
        .eq("account_id", accountId)
        .eq("status", "active")
        .select("id");
      if (error) throw new Error(error.message);
      return contar(data);
    })) as number;
  }

  // 4) Automatizaciones apagadas.
  r.automatizacionesApagadas = (await paso("automatizaciones", async () => {
    const { data, error } = await db
      .from("automations")
      .update({ is_active: false })
      .eq("account_id", accountId)
      .eq("is_active", true)
      .select("id");
    if (error) throw new Error(error.message);
    return contar(data);
  })) as number;

  // 5) Plantillas: eran de la WABA baneada; no sirven en otra.
  r.plantillasBorradas = (await paso("plantillas", async () => {
    const { data, error } = await db
      .from("message_templates")
      .delete()
      .eq("account_id", accountId)
      .select("id");
    if (error) throw new Error(error.message);
    return contar(data);
  })) as number;

  // 6) La conexión: al borrarla, la cuenta queda libre para otro número.
  if (config) {
    await paso("conexion", async () => {
      const { error } = await db.from("whatsapp_config").delete().eq("id", config.id);
      if (error) throw new Error(error.message);
      r.conexionBorrada = true;
    });
  }

  console.warn("[retiro] número retirado:", JSON.stringify(r));
  return r;
}
