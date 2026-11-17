// ============================================================
// HERRAMIENTAS DE MELISSA — Etapa 1
//
// Las seis funciones reales que el modelo puede pedir, con su esquema
// JSON y su VALIDACIÓN EN SERVIDOR. Regla de oro (§12): el modelo
// propone, el servidor decide. DeepSeek no puede cambiar los datos
// bancarios, inventar archivos, confirmar pagos, cambiar el destinatario,
// enviar documentos arbitrarios ni ignorar una baja.
//
// Cómo se consigue:
//   - `entregar_pack` y `enviar_datos_de_pago` NO reciben argumentos:
//     qué se manda y a quién lo decide el servidor (lista fija de
//     documentos y datos de la tabla `payment_details`).
//   - Todo texto que llega del modelo se recorta y se limpia antes de
//     guardarse.
//   - Ninguna herramienta borra historial ni toca el opt-out.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { fijarEstadoDeConversacion, marcarBaja } from "@/lib/messaging/estado";
import { entregarPack, type ResultadoEntrega } from "./entrega";

/** Estados que el modelo puede pedir (lista cerrada, no texto libre). */
const ESTADOS_PERMITIDOS = [
  "ACTIVE",
  "WAITING_USER",
  "WAITING_AI",
  "HUMAN_HANDOFF",
  "PAUSED",
  "CLOSED",
] as const;

export type EstadoPedido = (typeof ESTADOS_PERMITIDOS)[number];

export interface ContextoHerramientas {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  /** Clave de idempotencia de esta ejecución del agente. */
  idempotencyKey?: string | null;
}

export interface ResultadoHerramienta {
  ok: boolean;
  /** Lo que se le devuelve al modelo como `role: tool`. */
  datos: Record<string, unknown>;
}

const recortar = (t: unknown, max = 300): string =>
  typeof t === "string" ? t.trim().slice(0, max) : "";

// ---------------------------------------------------------------------------
// Esquemas (lo que ve DeepSeek)
// ---------------------------------------------------------------------------

export const ESQUEMAS = [
  {
    type: "function" as const,
    function: {
      name: "get_contact_context",
      description:
        "Devuelve el historial reciente de la clienta, sus etiquetas, su estado y qué documentos del pack ya recibió. Úsala antes de decidir nada.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_contact_state",
      description: "Guarda el estado de la conversación.",
      parameters: {
        type: "object",
        properties: {
          estado: {
            type: "string",
            enum: [...ESTADOS_PERMITIDOS],
            description: "Estado en el que queda la conversación.",
          },
        },
        required: ["estado"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deliver_product_bundle",
      description:
        "Entrega los cinco PDF del pack. SOLO cuando la clienta confirma de forma inequívoca que quiere recibirlo. No acepta argumentos: el servidor decide qué archivos y a quién.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_payment_details",
      description:
        "Manda los datos de pago. SOLO después de haber entregado los cinco archivos, y solo una vez en toda la conversación.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_payment_pending",
      description:
        "Anota que la clienta dice que ya pagó o que mandó comprobante. NO confirma el pago: solo lo deja pendiente de revisión humana.",
      parameters: {
        type: "object",
        properties: {
          nota: {
            type: "string",
            description: "Qué dijo exactamente (lo lee una persona después).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "handoff_human",
      description:
        "Pasa la conversación a una persona del equipo. Úsala si pide hablar con alguien, si reclama o si está molesta.",
      parameters: {
        type: "object",
        properties: { motivo: { type: "string", description: "Por qué se pasa." } },
        required: [],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Validación de argumentos (lo que llega del modelo)
// ---------------------------------------------------------------------------

export function validarArgumentos(
  nombre: string,
  args: unknown,
): { ok: true; valor: Record<string, unknown> } | { ok: false; error: string } {
  const bruto = (args ?? {}) as Record<string, unknown>;

  switch (nombre) {
    case "get_contact_context":
    case "deliver_product_bundle":
    case "send_payment_details":
      // Sin argumentos: si el modelo manda algo, se ignora por completo.
      return { ok: true, valor: {} };

    case "save_contact_state": {
      const estado = recortar(bruto.estado, 20).toUpperCase();
      if (!ESTADOS_PERMITIDOS.includes(estado as EstadoPedido)) {
        return { ok: false, error: `estado no permitido: ${estado || "(vacío)"}` };
      }
      return { ok: true, valor: { estado } };
    }

    case "mark_payment_pending":
      return { ok: true, valor: { nota: recortar(bruto.nota, 300) } };

    case "handoff_human":
      return { ok: true, valor: { motivo: recortar(bruto.motivo, 300) } };

    default:
      return { ok: false, error: `herramienta desconocida: ${nombre}` };
  }
}

// ---------------------------------------------------------------------------
// Ejecución (funciones reales del backend)
// ---------------------------------------------------------------------------

async function etiquetarContacto(
  accountId: string,
  contactId: string,
  nombre: string,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .eq("name", nombre)
      .maybeSingle();
    const tagId = (data as { id?: string } | null)?.id;
    if (!tagId) return;
    await db
      .from("contact_tags")
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: "contact_id,tag_id" });
  } catch {
    // La etiqueta es informativa: no puede tumbar la conversación.
  }
}

export async function ejecutarHerramienta(
  nombre: string,
  args: unknown,
  ctx: ContextoHerramientas,
): Promise<ResultadoHerramienta> {
  const validado = validarArgumentos(nombre, args);
  if (!validado.ok) {
    return { ok: false, datos: { error: validado.error } };
  }
  const db = supabaseAdmin();

  switch (nombre) {
    case "get_contact_context": {
      try {
        const [contacto, conversacion, mensajes, etiquetas, entregados] = await Promise.all([
          db
            .from("contacts")
            .select("name, phone, opt_out_at, consent_status, consent_source")
            .eq("id", ctx.contactId)
            .maybeSingle(),
          db
            .from("conversations")
            .select("state, ai_autoreply_disabled")
            .eq("id", ctx.conversationId)
            .maybeSingle(),
          db
            .from("messages")
            .select("sender_type, content_text, created_at")
            .eq("conversation_id", ctx.conversationId)
            .order("created_at", { ascending: false })
            .limit(14),
          db
            .from("contact_tags")
            .select("tags(name)")
            .eq("contact_id", ctx.contactId)
            .limit(20),
          import("./entrega").then((m) => m.documentosEntregados(ctx.conversationId)),
        ]);

        return {
          ok: true,
          datos: {
            contacto: contacto.data ?? null,
            estado_conversacion: (conversacion.data as { state?: string } | null)?.state ?? null,
            historial: ((mensajes.data as Array<{ sender_type: string; content_text: string | null }> | null) ?? [])
              .reverse()
              .map((m) => ({
                de: m.sender_type === "customer" ? "clienta" : "nosotros",
                texto: (m.content_text ?? "").slice(0, 400),
              })),
            etiquetas: ((etiquetas.data as Array<{ tags: { name: string } | null }> | null) ?? [])
              .map((e) => e.tags?.name)
              .filter(Boolean),
            documentos_entregados: [...entregados],
          },
        };
      } catch (err) {
        return { ok: false, datos: { error: err instanceof Error ? err.message : "error" } };
      }
    }

    case "save_contact_state": {
      const estado = validado.valor.estado as EstadoPedido;
      await fijarEstadoDeConversacion(ctx.conversationId, estado);
      return { ok: true, datos: { estado } };
    }

    case "deliver_product_bundle": {
      const r: ResultadoEntrega = await entregarPack({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        idempotencyKey: ctx.idempotencyKey ?? null,
      });
      if (r.estado !== "ya_entregada") {
        await etiquetarContacto(ctx.accountId, ctx.contactId, "recibio-pdf");
      }
      return { ok: r.estado !== "parcial", datos: { ...r } };
    }

    case "send_payment_details": {
      const { data } = await db
        .from("payment_details")
        .select("mensaje, activo")
        .eq("account_id", ctx.accountId)
        .maybeSingle();
      const fila = data as { mensaje?: string | null; activo?: boolean } | null;
      if (!fila?.activo || !fila.mensaje) {
        return {
          ok: false,
          datos: { error: "no hay datos de pago configurados en el servidor" },
        };
      }
      // Una sola vez: si ya se mandaron en esta conversación, no se repite.
      const { data: previos } = await db
        .from("outbound_message_log")
        .select("id")
        .eq("conversation_id", ctx.conversationId)
        .eq("source", "agente")
        .ilike("content_preview", "%CLABE%")
        .limit(1);
      if ((previos as unknown[] | null)?.length) {
        return { ok: true, datos: { ya_enviados: true } };
      }

      const { engineSendText } = await import("@/lib/flows/meta-send");
      await engineSendText({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        text: fila.mensaje,
        reason: "datos de pago (una sola vez)",
        idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:pago` : null,
      });
      return { ok: true, datos: { enviados: true } };
    }

    case "mark_payment_pending": {
      await etiquetarContacto(ctx.accountId, ctx.contactId, "pago-por-verificar");
      const nota = recortar(validado.valor.nota, 300);
      if (nota) {
        try {
          await db.from("contact_notes").insert({
            account_id: ctx.accountId,
            contact_id: ctx.contactId,
            user_id: ctx.userId,
            note: `Dice que pagó: ${nota}`,
          });
        } catch {
          // La nota es un extra; la etiqueta ya quedó.
        }
      }
      return { ok: true, datos: { marcado: "pago-por-verificar" } };
    }

    case "handoff_human": {
      await fijarEstadoDeConversacion(ctx.conversationId, "HUMAN_HANDOFF");
      await etiquetarContacto(ctx.accountId, ctx.contactId, "pide-humano");
      return { ok: true, datos: { traspasado: true } };
    }

    default:
      return { ok: false, datos: { error: `herramienta desconocida: ${nombre}` } };
  }
}

/** Se usa en las pruebas de la baja voluntaria. */
export { marcarBaja };
