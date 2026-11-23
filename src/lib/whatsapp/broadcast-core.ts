// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  enviarPlantilla,
  EnvioBloqueadoError,
  EnvioCalentamientoError,
  extraerErrorMeta,
} from '@/lib/messaging/send'
import { decrypt } from '@/lib/whatsapp/encryption';
import { credencialesDeConexion, credencialesPrimarias } from '@/lib/whatsapp/connections';
import {
  conexionBloqueaMasivo,
  diaCalentamiento,
  limiteCalentamiento,
} from '@/lib/whatsapp/warmup';
import {
  parseInternationalPhone,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /** Conexión que envía; si falta, se usa la primera conectada. */
  connectionId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  /** Para el registro de auditoría de la salida. */
  contactId?: string | null;
}

export interface BroadcastPlan {
  broadcastId: string;
  /** Cuenta dueña del envío (auditoría de salida). */
  accountId: string;
  templateName: string;
  templateLanguage: string;
  connectionId: string | null;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

export interface CreatedBroadcastPlan extends BroadcastPlan {
  duplicates: number;
  skippedOptOut: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<CreatedBroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  // Prefer the per-connection model; `whatsapp_config` stays as legacy
  // fallback for accounts that have not migrated.
  let creds = params.connectionId
    ? await credencialesDeConexion(db, params.connectionId)
    : await credencialesPrimarias(db, accountId);
  if (!creds) {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
    if (configError || !config) {
      throw new BroadcastError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    creds = {
      connectionId: null,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    };
  }

  let healthRow:
    | {
        health_status?: string | null;
        restriction_scope?: string | null;
        quality_rating?: string | null;
        warmup_enabled?: boolean | null;
        warmup_started_at?: string | null;
      }
    | null = null;
  if (creds?.connectionId) {
    const { data } = await db
      .from('whatsapp_connections')
      .select(
        'health_status, restriction_scope, quality_rating, warmup_enabled, warmup_started_at',
      )
      .eq('id', creds.connectionId)
      .maybeSingle();
    healthRow = (data as {
      health_status?: string | null;
      restriction_scope?: string | null;
      quality_rating?: string | null;
      warmup_enabled?: boolean | null;
      warmup_started_at?: string | null;
    } | null) ?? null;
  }
  if (healthRow) {
    const bloqueo = conexionBloqueaMasivo(healthRow);
    if (bloqueo.bloqueado) {
      throw new BroadcastError(
        'connection_restricted',
        bloqueo.motivo ?? 'La conexión está restringida por Meta.',
        409
      );
    }
  }

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  // `to` is raw integrator input, so the leading `+` is required — a
  // national-format number would otherwise be delivered to whichever
  // country its leading digits spell (issue #586).
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const to = typeof r.to === 'string' ? r.to : '';
    const sanitized = parseInternationalPhone(to);
    if (!sanitized) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: to,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid international phone number (leading + and country code, e.g. +14155550123)',
      400,
    );
  }

  // Opt-out: un broadcast es marketing. `marketing_opted_out` bloquea
  // solo marketing (131050/user_preferences); `opted_out` bloquea todo.
  let skippedOptOut = 0;
  let permitidos = deduped;
  if (deduped.length > 0) {
    const { data: contactos } = await db
      .from('contacts')
      .select('id, opted_out, marketing_opted_out, consent_status')
      .in('id', deduped.map((r) => r.contactId));
    const bloqueados = new Set(
      ((contactos ?? []) as Array<{
        id: string;
        opted_out?: boolean;
        marketing_opted_out?: boolean;
        consent_status?: string | null;
      }>)
        .filter(
          (c) =>
            c.opted_out ||
            c.marketing_opted_out ||
            c.consent_status === 'denied',
        )
        .map((c) => c.id),
    );
    permitidos = deduped.filter((r) => !bloqueados.has(r.contactId));
    skippedOptOut = deduped.length - permitidos.length;
  }

  if (permitidos.length === 0) {
    throw new BroadcastError(
      'all_opted_out',
      'Todos los destinatarios tienen opt-out o consentimiento denegado.',
      409,
    );
  }

  // Warm-up: si el cupo de hoy no alcanza, se rechaza el broadcast
  // completo con el dato exacto; el wizard puede reducir la audiencia.
  if (healthRow?.warmup_enabled) {
    const limite = limiteCalentamiento(healthRow.warmup_started_at);
    if (limite !== null) {
      const dia = new Date().toISOString().slice(0, 10);
      const { data: uso } = await db
        .from('connection_warmup_sends')
        .select('sent_count')
        .eq('connection_id', creds!.connectionId)
        .eq('day', dia)
        .maybeSingle();
      const usados = Number((uso as { sent_count?: number } | null)?.sent_count) || 0;
      if (permitidos.length > Math.max(0, limite - usados)) {
        throw new BroadcastError(
          'warmup_limit',
          `El calentamiento de esta conexión permite ${limite}/día (día ${diaCalentamiento(
            healthRow.warmup_started_at,
          )}); hoy quedan ${Math.max(0, limite - usados)}. Reduce la audiencia o espera a mañana.`,
          429,
        );
      }
    }
  }

  if (permitidos.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid international phone number (leading + and country code, e.g. +14155550123)',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: permitidos.length,
      p_contact_ids: permitidos.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: permitidos.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  if (creds?.connectionId) {
    await db
      .from('broadcasts')
      .update({ connection_id: creds!.connectionId })
      .eq('id', broadcastId);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(permitidos.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
        // Para el registro de auditoría: a qué contacto se le mandó.
        contactId: row.contact_id,
      };
    }
  );

  return {
    broadcastId,
    accountId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    connectionId: creds!.connectionId,
    phoneNumberId: creds.phoneNumberId,
    accessToken: creds.accessToken,
    templateRow,
    planned,
    rejected,
    duplicates: resolved.length - deduped.length,
    skippedOptOut,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  let pausado = false;
  for (let index = 0; index < plan.planned.length; index += 1) {
    const recipient = plan.planned[index];

    // La salud puede cambiar a mitad del envío (webhook de Meta). Se
    // consulta el estado del broadcast cada 10 destinatarios y al inicio.
    if (index === 0 || index % 10 === 0) {
      const { data: estado } = await db
        .from('broadcasts')
        .select('status')
        .eq('id', plan.broadcastId)
        .maybeSingle();
      if ((estado as { status?: string } | null)?.status === 'paused') {
        pausado = true;
        break;
      }
    }

    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;
    let errorCode: string | null = null;

    for (const variant of variants) {
      try {
        const result = await enviarPlantilla({
          ctx: {
            accountId: plan.accountId,
            contactId: recipient.contactId ?? null,
            connectionId: plan.connectionId,
            source: 'difusion',
            templateCategory: plan.templateRow?.category ?? 'Marketing',
            reason: `difusión: ${plan.templateName}`,
            workflowId: plan.broadcastId ?? null,
          },
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        if (error instanceof EnvioCalentamientoError) {
          await db
            .from('broadcasts')
            .update({
              status: 'paused',
              paused_at: new Date().toISOString(),
              pause_reason: 'warmup_limit',
            })
            .eq('id', plan.broadcastId);
          pausado = true;
          break;
        }
        if (error instanceof EnvioBloqueadoError) {
          lastError = error.message;
          errorCode = error.motivo;
          if (
            error.motivo === 'connection_health' ||
            error.motivo === 'connection_restricted'
          ) {
            await db
              .from('broadcasts')
              .update({
                status: 'paused',
                paused_at: new Date().toISOString(),
                pause_reason: error.motivo,
              })
              .eq('id', plan.broadcastId);
            pausado = true;
          }
          break;
        }
        const meta = extraerErrorMeta(error);
        lastError = meta.message;
        errorCode = meta.code;
        if (meta.code === '130429') {
          await db
            .from('broadcasts')
            .update({
              status: 'paused',
              paused_at: new Date().toISOString(),
              pause_reason: 'rate_limit',
            })
            .eq('id', plan.broadcastId);
          pausado = true;
          break;
        }
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(meta.message)) break;
      }
    }

    if (pausado) break;

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
          error_code: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
          error_code: errorCode,
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  if (!pausado) {
    await finalizeBroadcastStatus(db, plan.broadcastId);
  }
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
