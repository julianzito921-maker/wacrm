/**
 * Lógica de los bloques Kanban, Template WhatsApp y Botón Pago / SPEI
 * (migración 079). El motor (`engine.ts`) solo decide CUÁNDO correrlos;
 * aquí vive el QUÉ, con las partes puras exportadas para las pruebas.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { evaluarComprobante, ultimos4, type LecturaComprobante } from "@/lib/ventas/comprobante";
import type { SendPaymentNodeConfig } from "./types";
import type { DatosFichas } from "./fichas";

export {
  CAMPOS_CONTACTO,
  parametrosDePlantilla,
  sustituirFichas,
  variablesDelCuerpo,
  type DatosFichas,
} from "./fichas";

/** ¿El texto usa alguna ficha de contacto o campo personalizado? */
function necesitaContacto(textos: string[]): boolean {
  return textos.some((t) => /\{\{\s*(contact|custom)\./.test(t));
}

/** Carga solo lo que las fichas necesitan (una o dos consultas). */
export async function cargarDatosFichas(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; vars: Record<string, unknown>; textos: string[] },
): Promise<DatosFichas> {
  const datos: DatosFichas = { contacto: {}, personalizados: {}, vars: args.vars ?? {} };
  if (!necesitaContacto(args.textos)) return datos;
  const { data: contacto } = await db
    .from("contacts")
    .select("name, phone, email, company")
    .eq("id", args.contactId)
    .eq("account_id", args.accountId)
    .maybeSingle();
  datos.contacto = (contacto as Record<string, unknown> | null) ?? {};
  if (args.textos.some((t) => /\{\{\s*custom\./.test(t))) {
    const { data: filas } = await db
      .from("contact_custom_values")
      .select("value, custom_fields!inner(field_name, account_id)")
      .eq("contact_id", args.contactId)
      .eq("custom_fields.account_id", args.accountId);
    for (const f of (filas ?? []) as unknown as {
      value: string;
      custom_fields: { field_name: string };
    }[]) {
      datos.personalizados[f.custom_fields.field_name] = f.value;
    }
  }
  return datos;
}

// ============================================================
// Kanban
// ============================================================

export interface ResultadoKanban {
  dealId: string | null;
  /** Etapa en la que estaba (null si el trato es nuevo). */
  desdeEtapa: string | null;
  accion: "movido" | "creado" | "sin_cambio" | "sin_trato";
}

/**
 * Mueve el trato ABIERTO del contacto en ese embudo a la etapa pedida.
 * Si no tiene y `crear` es true, crea uno con la moneda de la cuenta.
 * Valida que la etapa sea de ese embudo y que el embudo sea de la cuenta.
 */
export async function moverContactoEnKanban(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    contactId: string;
    conversationId: string | null;
    pipelineId: string;
    stageId: string;
    crear: boolean;
    titulo: string;
  },
): Promise<ResultadoKanban> {
  const { data: etapa } = await db
    .from("pipeline_stages")
    .select("id, pipeline_id, pipelines!inner(account_id)")
    .eq("id", args.stageId)
    .eq("pipeline_id", args.pipelineId)
    .eq("pipelines.account_id", args.accountId)
    .maybeSingle();
  if (!etapa) throw new Error("la etapa no pertenece a ese embudo o a la cuenta");

  const { data: tratos } = await db
    .from("deals")
    .select("id, stage_id")
    .eq("account_id", args.accountId)
    .eq("contact_id", args.contactId)
    .eq("pipeline_id", args.pipelineId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1);
  const trato = (tratos as { id: string; stage_id: string }[] | null)?.[0];

  if (trato) {
    if (trato.stage_id === args.stageId) {
      return { dealId: trato.id, desdeEtapa: trato.stage_id, accion: "sin_cambio" };
    }
    const { error } = await db
      .from("deals")
      .update({ stage_id: args.stageId, updated_at: new Date().toISOString() })
      .eq("id", trato.id)
      .eq("account_id", args.accountId);
    if (error) throw new Error(error.message);
    return { dealId: trato.id, desdeEtapa: trato.stage_id, accion: "movido" };
  }

  if (!args.crear) return { dealId: null, desdeEtapa: null, accion: "sin_trato" };

  const { data: cuenta } = await db
    .from("accounts")
    .select("default_currency")
    .eq("id", args.accountId)
    .maybeSingle();
  const { data: nuevo, error } = await db
    .from("deals")
    .insert({
      account_id: args.accountId,
      user_id: args.userId,
      pipeline_id: args.pipelineId,
      stage_id: args.stageId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      title: args.titulo || "Nuevo trato",
      value: 0,
      currency: (cuenta as { default_currency?: string } | null)?.default_currency ?? "MXN",
      status: "open",
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { dealId: (nuevo as { id: string } | null)?.id ?? null, desdeEtapa: null, accion: "creado" };
}

// ============================================================
// Botón Pago / SPEI
// ============================================================

export interface DatosPago {
  clabe: string;
  beneficiario: string;
  banco: string;
  monto: number;
  referencia: string;
}

/** Completa lo vacío del nodo con `payment_details` de la cuenta. Pura. */
export function combinarDatosPago(
  cfg: SendPaymentNodeConfig,
  cuenta: { clabe?: string | null; holder?: string | null; bank?: string | null } | null,
): DatosPago {
  return {
    clabe: (cfg.clabe || cuenta?.clabe || "").replace(/\s+/g, ""),
    beneficiario: cfg.beneficiario || cuenta?.holder || "",
    banco: cfg.banco || cuenta?.bank || "",
    monto: Number(cfg.monto) || 0,
    referencia: cfg.referencia || "",
  };
}

const formatoMonto = (n: number) =>
  `$${n.toLocaleString("es-MX", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} MXN`;

/**
 * Texto con los datos SPEI. Corto y limpio (regla de venta conversacional):
 * la CLABE va sola en su renglón para que se pueda copiar con un toque largo.
 * Pura.
 */
export function textoPagoSpei(datos: DatosPago, mensaje?: string): string {
  const renglones = [
    (mensaje && mensaje.trim()) || "Te paso los datos para tu transferencia SPEI 👇",
    "",
    `*Monto:* ${formatoMonto(datos.monto)}`,
    datos.banco ? `*Banco:* ${datos.banco}` : "",
    datos.beneficiario ? `*Beneficiario:* ${datos.beneficiario}` : "",
    "*CLABE:*",
    datos.clabe,
    datos.referencia ? `*Concepto / referencia:* ${datos.referencia}` : "",
    "",
    "Cuando pagues, mándame la captura o el PDF del comprobante por aquí 📸",
  ];
  return renglones
    .filter((r, i, todos) => r !== "" || (i > 0 && todos[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Botones (solo si el nodo los enciende). */
export const BOTONES_PAGO = [
  { reply_id: "pago_ya", title: "Ya pagué ✅" },
  { reply_id: "pago_duda", title: "Tengo una duda" },
] as const;

export const TEXTO_PIDE_COMPROBANTE =
  "Perfecto 🙌 mándame la captura o el PDF de tu transferencia por aquí y lo reviso.";
export const TEXTO_NO_ES_COMPROBANTE =
  "Mmm 🤔 eso no parece un comprobante de pago. ¿Me mandas la captura o el PDF de tu transferencia? 📸";

export type VeredictoPago =
  | { resultado: "aprobado"; motivos: string[] }
  | { resultado: "rechazado"; motivos: string[] }
  /** No es un comprobante (selfie, meme…): se le pide otra vez. */
  | { resultado: "reintentar"; motivos: string[] };

/**
 * Decide qué hacer con un comprobante leído, contra el monto y la CLABE
 * de ESTE nodo. `referenciaRepetida` la calcula quien llama (consulta).
 * Pura.
 */
export function veredictoPago(
  lectura: LecturaComprobante | null,
  datos: DatosPago,
  referenciaRepetida: boolean,
): VeredictoPago {
  if (!lectura) {
    return { resultado: "rechazado", motivos: ["no se pudo leer el comprobante: revisar a mano"] };
  }
  if (!lectura.es_comprobante) return { resultado: "reintentar", motivos: ["no parece comprobante"] };
  const digitos = ultimos4(datos.clabe);
  const { ok, motivos } = evaluarComprobante(
    lectura,
    digitos ? [digitos] : [],
    datos.monto > 0 ? [datos.monto] : [],
  );
  if (referenciaRepetida) {
    motivos.push(`referencia ${lectura.referencia} repetida (ya se aprobó otro comprobante con ella)`);
  }
  return ok && !referenciaRepetida
    ? { resultado: "aprobado", motivos: [] }
    : { resultado: "rechazado", motivos };
}
