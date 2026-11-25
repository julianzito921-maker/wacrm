// ============================================================
// WEBHOOKS DE SALUD DE WHATSAPP (2026)
//
// account_update, account_alerts, phone_number_quality_update,
// business_capability_update, account_review_update,
// message_template_quality_update y user_preferences.
//
// Lo importante:
//   - phone_number_quality_update NO trae el color de calidad; hay que
//     reconciliar con GET /{phone_number_id}.
//   - business_capability_update/account_alerts traen el límite de
//     portafolio (max_daily_conversations_per_business).
//   - Cualquier restricción o RED pausa los broadcasts de esa conexión
//     y crea una notificación urgente; no apaga todo el CRM.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getPhoneNumberHealth } from "@/lib/whatsapp/meta-api";
import { parseQualityRating } from "@/lib/whatsapp/phone-health";
import { decrypt } from "@/lib/whatsapp/encryption";
import { marcarOptOutMarketing, quitarOptOutMarketing } from "@/lib/messaging/opt-out";

export const HEALTH_WEBHOOK_FIELDS = [
  "account_update",
  "account_alerts",
  "phone_number_quality_update",
  "business_capability_update",
  "account_review_update",
  "message_template_quality_update",
  "user_preferences",
] as const;

export type HealthWebhookField = (typeof HEALTH_WEBHOOK_FIELDS)[number];

export function isHealthWebhookField(field: string): field is HealthWebhookField {
  return (HEALTH_WEBHOOK_FIELDS as readonly string[]).includes(field);
}

interface ConexionSalud {
  id: string;
  account_id: string;
  waba_id: string | null;
  phone_number: string | null;
  display_phone_number: string | null;
  phone_number_id: string;
  access_token: string;
  quality_rating: string | null;
  health_status: string | null;
  warmup_enabled: boolean | null;
  warmup_started_at: string | null;
}

type Db = SupabaseClient;

function digitos(valor: unknown): string {
  return String(valor ?? "").replace(/\D/g, "");
}

function primerTexto(...valores: unknown[]): string | null {
  for (const v of valores) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function arrayDe(valor: unknown): Array<Record<string, unknown>> {
  return Array.isArray(valor)
    ? (valor.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>)
    : [];
}

async function conexionesDeWaba(db: Db, wabaId: string): Promise<ConexionSalud[]> {
  const { data } = await db
    .from("whatsapp_connections")
    .select(
      "id, account_id, waba_id, phone_number, display_phone_number, phone_number_id, access_token, quality_rating, health_status, warmup_enabled, warmup_started_at",
    )
    .eq("waba_id", wabaId);
  return (data as ConexionSalud[] | null) ?? [];
}

async function conexionPorNumero(
  db: Db,
  wabaId: string,
  numero: string | null,
): Promise<ConexionSalud | null> {
  const conexiones = await conexionesDeWaba(db, wabaId);
  const buscado = digitos(numero);
  if (!buscado) return conexiones[0] ?? null;
  return (
    conexiones.find(
      (c) =>
        digitos(c.display_phone_number) === buscado ||
        digitos(c.phone_number) === buscado,
    ) ??
    conexiones[0] ??
    null
  );
}

async function alertaReciente(db: Db, accountId: string, regla: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("messaging_alerts")
      .select("id")
      .eq("account_id", accountId)
      .eq("regla", regla)
      .gte("created_at", new Date(Date.now() - 6 * 3_600_000).toISOString())
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Notificación urgente para dueño/admins + alerta de mensajería. */
export async function alertarSalud(
  db: Db,
  args: {
    accountId: string;
    regla: string;
    titulo: string;
    detalle: string;
    severidad?: "warning" | "critical";
    accion?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (await alertaReciente(db, args.accountId, args.regla)) return;

  try {
    await db.from("messaging_alerts").insert({
      account_id: args.accountId,
      regla: args.regla,
      severidad: args.severidad ?? "critical",
      detalle: {
        texto: args.detalle,
        ...(args.metadata ?? {}),
      } as never,
      accion: args.accion ?? "avisar",
    });
  } catch (err) {
    console.error(
      "[health] no se pudo crear messaging_alert:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const { data: admins } = await db
      .from("profiles")
      .select("user_id, account_role")
      .eq("account_id", args.accountId)
      .in("account_role", ["owner", "admin"]);
    let destinatarios = ((admins ?? []) as Array<{ user_id: string }>).map(
      (a) => a.user_id,
    );
    if (destinatarios.length === 0) {
      const { data: cuenta } = await db
        .from("accounts")
        .select("owner_user_id")
        .eq("id", args.accountId)
        .maybeSingle();
      const owner = (cuenta as { owner_user_id?: string } | null)?.owner_user_id;
      if (owner) destinatarios = [owner];
    }
    for (const userId of new Set(destinatarios)) {
      await db.from("notifications").insert({
        account_id: args.accountId,
        user_id: userId,
        type: "account_health",
        title: args.titulo,
        body: args.detalle.slice(0, 500),
      } as never);
    }
  } catch (err) {
    console.error(
      "[health] no se pudo crear la notificación:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Pausa broadcasts y cola de difusión de las conexiones indicadas. */
export async function pausarBroadcastsDeConexiones(
  db: Db,
  args: { connectionIds: string[]; reason: string },
): Promise<number> {
  if (args.connectionIds.length === 0) return 0;
  let pausados = 0;
  try {
    const { data } = await db
      .from("broadcasts")
      .update({
        status: "paused",
        paused_at: new Date().toISOString(),
        pause_reason: args.reason,
      })
      .in("connection_id", args.connectionIds)
      .in("status", ["sending", "scheduled"])
      .select("id");
    pausados = data?.length ?? 0;
  } catch (err) {
    console.error(
      "[health] no se pudieron pausar broadcasts:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await db
      .from("outbound_message_queue")
      .update({
        status: "PAUSED",
        last_error: args.reason.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .in("connection_id", args.connectionIds)
      .eq("source", "difusion")
      .in("status", ["PENDING", "PROCESSING"]);
  } catch (err) {
    console.error(
      "[health] no se pudo pausar la cola de difusión:",
      err instanceof Error ? err.message : err,
    );
  }
  return pausados;
}

async function actualizarSalud(
  db: Db,
  conexion: ConexionSalud,
  patch: {
    health_status: "healthy" | "warning" | "restricted" | "blocked";
    restriction_scope?: "mass" | "all" | null;
    health_reason?: string | null;
    restricted_until?: string | null;
  },
): Promise<void> {
  await db
    .from("whatsapp_connections")
    .update({
      health_status: patch.health_status,
      restriction_scope: patch.restriction_scope ?? null,
      health_reason: patch.health_reason ?? null,
      restricted_until: patch.restricted_until ?? null,
      last_health_event_at: new Date().toISOString(),
    })
    .eq("id", conexion.id);
}

async function reconciliarSaludNumero(
  db: Db,
  conexion: ConexionSalud,
): Promise<{ quality: string; limit: string | null } | null> {
  try {
    const info = await getPhoneNumberHealth({
      phoneNumberId: conexion.phone_number_id,
      accessToken: decrypt(conexion.access_token),
    });
    const quality = parseQualityRating(info.quality_rating);
    const limit = info.whatsapp_business_manager_messaging_limit ?? null;
    await db
      .from("whatsapp_connections")
      .update({
        quality_rating: info.quality_rating ?? conexion.quality_rating,
        whatsapp_business_manager_messaging_limit: limit,
        display_phone_number:
          info.display_phone_number ?? conexion.display_phone_number,
        messaging_limit_updated_at: new Date().toISOString(),
        last_health_event_at: new Date().toISOString(),
      })
      .eq("id", conexion.id);
    return { quality, limit };
  } catch (err) {
    console.error(
      "[health] no se pudo reconciliar el número:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function aplicarRestriccionCuenta(
  db: Db,
  conexiones: ConexionSalud[],
  args: {
    event: string;
    restrictionInfo: Array<Record<string, unknown>>;
    banInfo: Record<string, unknown> | null;
    violationInfo: Record<string, unknown> | null;
  },
): Promise<void> {
  const tipos = args.restrictionInfo
    .map((r) => primerTexto(r.restriction_type, r.type, r.name))
    .filter((x): x is string => Boolean(x))
    .join(" ")
    .toUpperCase();
  const expiraciones = args.restrictionInfo
    .map((r) => Number(r.expiration ?? r.expires_at ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const hasta = expiraciones.length
    ? new Date(Math.min(...expiraciones) * 1000).toISOString()
    : null;

  const event = args.event.toUpperCase();
  const baneada =
    Boolean(args.banInfo) ||
    event.includes("DELETED") ||
    event.includes("BANNED") ||
    event.includes("DISABLE");
  const soloCliente =
    tipos.includes("CUSTOMER_INITIATED") && !tipos.includes("BIZ_INITIATED");
  const masa =
    tipos.includes("BIZ_INITIATED") || event.includes("RESTRICTION");
  const haySenal =
    baneada ||
    args.restrictionInfo.length > 0 ||
    Boolean(args.violationInfo) ||
    event.includes("RESTRICTION") ||
    event.includes("VIOLATION") ||
    event.includes("APPEAL");
  if (!haySenal) return;

  const health = baneada
    ? "blocked"
    : soloCliente
      ? "blocked"
      : "restricted";
  const scope = baneada || soloCliente ? "all" : masa ? "mass" : "mass";
  const detalle =
    primerTexto(
      args.banInfo?.reason,
      args.violationInfo?.reason,
      args.restrictionInfo[0]?.reason,
      args.event,
    ) ?? "Meta envió un evento de restricción de cuenta.";

  for (const conexion of conexiones) {
    await actualizarSalud(db, conexion, {
      health_status: health,
      restriction_scope: scope,
      health_reason: detalle,
      restricted_until: hasta,
    });
  }

  const pausados = await pausarBroadcastsDeConexiones(db, {
    connectionIds: conexiones.map((c) => c.id),
    reason: detalle,
  });
  const cuenta = conexiones[0]?.account_id;
  if (cuenta) {
    await alertarSalud(db, {
      accountId: cuenta,
      regla: "cuenta_restringida",
      titulo: "Restricción de WhatsApp",
      detalle: `${detalle} Broadcasts pausados: ${pausados}.`,
      accion: "broadcasts_pausados",
      metadata: { event: args.event, scope, hasta },
    });
  }
}

async function aplicarCalidadNumero(
  db: Db,
  conexiones: ConexionSalud[],
  value: Record<string, unknown>,
): Promise<void> {
  const conexion =
    (await conexionPorNumero(
      db,
      String(value.waba_id ?? ""),
      primerTexto(value.display_phone_number, value.phone_number),
    )) ?? conexiones[0];
  if (!conexion) return;

  const event = String(value.event ?? "").toUpperCase();
  const limite = primerTexto(
    value.max_daily_conversations_per_business,
    value.current_limit,
  );

  if (limite) {
    await db
      .from("whatsapp_connections")
      .update({
        whatsapp_business_manager_messaging_limit: limite,
        messaging_limit_updated_at: new Date().toISOString(),
        last_health_event_at: new Date().toISOString(),
      })
      .eq("id", conexion.id);
  }

  const reconciliado = await reconciliarSaludNumero(db, conexion);
  const quality = reconciliado?.quality ?? "UNKNOWN";
  const rojo =
    quality === "RED" ||
    event === "FLAGGED" ||
    event.includes("RED");
  const amarillo = quality === "YELLOW" || event.includes("YELLOW");

  await actualizarSalud(db, conexion, {
    health_status: rojo ? "restricted" : amarillo ? "warning" : "healthy",
    restriction_scope: rojo ? "mass" : null,
    health_reason: rojo
      ? `Calidad ${quality}${event ? ` (${event})` : ""}`
      : amarillo
        ? `Calidad ${quality}${event ? ` (${event})` : ""}`
        : null,
  });

  if (rojo) {
    const pausados = await pausarBroadcastsDeConexiones(db, {
      connectionIds: [conexion.id],
      reason: `Calidad del número en RED (${conexion.phone_number_id}).`,
    });
    await alertarSalud(db, {
      accountId: conexion.account_id,
      regla: "calidad_numero",
      titulo: "Calidad del número en RED",
      detalle: `El número ${conexion.display_phone_number ?? conexion.phone_number} está en RED. Broadcasts pausados: ${pausados}.`,
      metadata: { quality, event, limite },
    });
  } else if (amarillo) {
    await alertarSalud(db, {
      accountId: conexion.account_id,
      regla: "calidad_numero_amarilla",
      titulo: "Calidad del número en amarillo",
      detalle: "Baja el ritmo de envíos para no llegar a RED.",
      severidad: "warning",
      metadata: { quality, event, limite },
    });
  }
}

async function aplicarLimitePortafolio(
  db: Db,
  conexiones: ConexionSalud[],
  value: Record<string, unknown>,
): Promise<void> {
  const limite = primerTexto(
    value.max_daily_conversations_per_business,
    value.current_limit,
    value.limit,
  );
  if (!limite || conexiones.length === 0) return;
  await db
    .from("whatsapp_connections")
    .update({
      whatsapp_business_manager_messaging_limit: limite,
      messaging_limit_updated_at: new Date().toISOString(),
      last_health_event_at: new Date().toISOString(),
    })
    .in("id", conexiones.map((c) => c.id));
}

async function aplicarUserPreferences(
  db: Db,
  conexiones: ConexionSalud[],
  value: Record<string, unknown>,
): Promise<void> {
  const rawUserId = primerTexto(value.user_id);
  const waId = digitos(
    primerTexto(value.wa_id, value.phone_number, value.display_phone_number),
  );
  if (!waId && !rawUserId) return;
  const accountIds = [...new Set(conexiones.map((c) => c.account_id))];
  const optOut =
    value.marketing_opt_out === true ||
    value.opt_out === true ||
    value.marketing_opt_out === "true";
  for (const accountId of accountIds) {
    let contactId: string | null = null;
    if (waId) {
      const { data } = await db
        .from("contacts")
        .select("id")
        .eq("account_id", accountId)
        .eq("phone_normalized", waId)
        .maybeSingle();
      contactId = (data as { id?: string } | null)?.id ?? null;
    }
    if (!contactId && rawUserId) {
      const { data } = await db
        .from("contacts")
        .select("id")
        .eq("account_id", accountId)
        .eq("wa_user_id", rawUserId)
        .maybeSingle();
      contactId = (data as { id?: string } | null)?.id ?? null;
    }
    if (!contactId) continue;
    if (optOut) {
      await marcarOptOutMarketing({ contactId, origen: "user_preferences" });
    } else {
      await quitarOptOutMarketing(contactId);
    }
  }
}

/**
 * message_template_quality_update: el `quality_score` de la plantilla lo
 * escribe template-webhook (handleQualityUpdate, que lee
 * `new_quality_score` y crea la fila si aún no existe). Aquí solo va la
 * reacción de salud: una plantilla en RED pausa los broadcasts que la usan
 * en las cuentas dueñas de esta WABA.
 *
 * Antes se leía `quality_score`/`event` (Meta manda `new_quality_score`,
 * así que todo quedaba en GREEN), se buscaba por nombre sin filtrar por
 * cuenta y se usaba `.maybeSingle()`, que falla con varias filas.
 */
async function aplicarCalidadPlantilla(
  db: Db,
  conexiones: ConexionSalud[],
  value: Record<string, unknown>,
): Promise<void> {
  const templateId = primerTexto(value.message_template_id);
  const nombre = primerTexto(value.message_template_name, value.template_name);
  const quality = (
    primerTexto(value.new_quality_score, value.quality_score, value.event) ?? ""
  ).toUpperCase();
  if ((!templateId && !nombre) || !quality.includes("RED")) return;

  const accountIds = [...new Set(conexiones.map((c) => c.account_id))];
  if (accountIds.length === 0) return;

  let filas: Array<{ account_id?: string; name?: string }> = [];
  if (templateId) {
    const { data } = await db
      .from("message_templates")
      .select("account_id, name")
      .in("account_id", accountIds)
      .eq("meta_template_id", templateId);
    filas = (data as typeof filas | null) ?? [];
  }
  if (filas.length === 0 && nombre) {
    const { data } = await db
      .from("message_templates")
      .select("account_id, name")
      .in("account_id", accountIds)
      .eq("name", nombre);
    filas = (data as typeof filas | null) ?? [];
  }
  if (filas.length === 0 && nombre) {
    // Plantilla aún sin fila local: se pausa por el nombre que trae Meta.
    filas = accountIds.map((account_id) => ({ account_id, name: nombre }));
  }

  const vistos = new Set<string>();
  for (const p of filas) {
    if (!p.account_id || !p.name) continue;
    const clave = `${p.account_id}:${p.name}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const { data: broadcasts } = await db
      .from("broadcasts")
      .update({
        status: "paused",
        paused_at: new Date().toISOString(),
        pause_reason: "template_quality_red",
      })
      .eq("account_id", p.account_id)
      .eq("template_name", p.name)
      .in("status", ["sending", "scheduled"])
      .select("id");
    if ((broadcasts?.length ?? 0) > 0) {
      await alertarSalud(db, {
        accountId: p.account_id,
        regla: "plantilla_calidad_roja",
        titulo: "Plantilla con calidad roja",
        detalle: `La plantilla ${p.name} está en RED; broadcasts pausados: ${broadcasts?.length}.`,
        metadata: { template: p.name, quality },
      });
    }
  }
}

/** Punto único que llama el webhook de WhatsApp. */
export async function handleHealthWebhookChange(args: {
  field: HealthWebhookField;
  value: unknown;
  wabaId: string;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? supabaseAdmin();
  const value =
    args.value && typeof args.value === "object"
      ? (args.value as Record<string, unknown>)
      : {};
  const conexiones = await conexionesDeWaba(db, args.wabaId);
  if (conexiones.length === 0) return;

  switch (args.field) {
    case "account_update": {
      await aplicarRestriccionCuenta(db, conexiones, {
        event: String(value.event ?? ""),
        restrictionInfo: arrayDe(value.restriction_info),
        banInfo:
          value.ban_info && typeof value.ban_info === "object"
            ? (value.ban_info as Record<string, unknown>)
            : null,
        violationInfo:
          value.violation_info && typeof value.violation_info === "object"
            ? (value.violation_info as Record<string, unknown>)
            : null,
      });
      break;
    }
    case "account_alerts":
    case "business_capability_update": {
      await aplicarLimitePortafolio(db, conexiones, value);
      break;
    }
    case "phone_number_quality_update": {
      await aplicarCalidadNumero(db, conexiones, { ...value, waba_id: args.wabaId });
      break;
    }
    case "account_review_update": {
      await alertarSalud(db, {
        accountId: conexiones[0].account_id,
        regla: "revision_cuenta",
        titulo: "Revisión de cuenta de WhatsApp",
        detalle: `Meta actualizó la revisión de la cuenta: ${primerTexto(value.event, value.decision) ?? "sin detalle"}.`,
        severidad: "warning",
      });
      break;
    }
    case "message_template_quality_update": {
      await aplicarCalidadPlantilla(db, conexiones, value);
      break;
    }
    case "user_preferences": {
      await aplicarUserPreferences(db, conexiones, value);
      break;
    }
  }
}
