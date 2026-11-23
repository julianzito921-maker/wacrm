import { supabaseAdmin } from '@/lib/flows/admin-client';
import { validateFlowForActivation } from '@/lib/flows/validate';
import { engineSendText } from '@/lib/flows/meta-send';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { enviarEventoMeta } from '@/lib/ventas/conversiones';
import type { McpAuthContext } from './auth';
import { tieneScope } from './auth';
import { McpToolError } from './errors';
import {
  normalizeFunnel,
  type FriendlyFunnel,
  type McpWorkspaceData,
} from './normalizer';
import {
  ensureConversation,
  loadWorkspace,
  rethrowNormalize,
  resolveContact,
  resolveFlow,
  ownerUserId,
} from './workspace';

function requireScope(ctx: McpAuthContext, scope: Parameters<typeof tieneScope>[1]) {
  if (!tieneScope(ctx, scope)) {
    throw new McpToolError(
      `La credencial no tiene el permiso «${scope}». Crea otra con ese scope.`,
      'forbidden',
    );
  }
}

// ------------------------------------------------------------------
// 1) Contexto del workspace
// ------------------------------------------------------------------
export async function getWorkspaceContext(ctx: McpAuthContext) {
  requireScope(ctx, 'read');
  const w = await loadWorkspace(ctx.accountId);
  return {
    account: w.account,
    pipelines: w.pipelines,
    tags: w.tags,
    custom_fields: w.fields,
    approved_templates: w.templates,
    payment: w.payment,
    tracking: w.tracking,
    flows: w.flows,
    notes: [
      'La CLABE va enmascarada: el nodo send_payment usa los datos completos guardados en el servidor.',
      'Los nombres de embudo/etapa/etiqueta/plantilla se pueden usar tal cual en deploy_complete_funnel.',
    ],
  };
}

// ------------------------------------------------------------------
// 2) Desplegar un embudo completo
// ------------------------------------------------------------------
export async function deployCompleteFunnel(
  ctx: McpAuthContext,
  input: {
    flow_id?: string;
    name: string;
    trigger?: FriendlyFunnel['trigger'];
    nodes: FriendlyFunnel['nodes'];
    activate?: boolean;
  },
) {
  requireScope(ctx, 'write_flows');
  const workspace = await loadWorkspace(ctx.accountId);
  const data: McpWorkspaceData = {
    pipelines: workspace.pipelines,
    tags: workspace.tags,
    templates: workspace.templates,
  };

  let normalized;
  try {
    normalized = normalizeFunnel(
      { name: input.name, trigger: input.trigger, nodes: input.nodes },
      data,
    );
  } catch (err) {
    rethrowNormalize(err);
  }

  const issues = validateFlowForActivation(
    {
      name: normalized.name,
      trigger_type: normalized.trigger_type,
      trigger_config: normalized.trigger_config,
      entry_node_id: normalized.entry_node_id,
    },
    normalized.nodes,
  );
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return {
      saved: false,
      flow_id: input.flow_id ?? null,
      issues,
      hint: 'Corrige los issues y vuelve a llamar. No se escribió nada.',
    };
  }

  const db = supabaseAdmin();
  let flowId = input.flow_id;

  if (flowId) {
    const { data: existing } = await db
      .from('flows')
      .select('id')
      .eq('id', flowId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!existing) {
      throw new McpToolError('Ese flujo no pertenece a la cuenta.', 'not_found');
    }
  } else {
    const { data: creado, error } = await db
      .from('flows')
      .insert({
        account_id: ctx.accountId,
        user_id: workspace.account.ownerUserId,
        name: normalized.name,
        status: 'draft',
        trigger_type: normalized.trigger_type,
        trigger_config: normalized.trigger_config,
        entry_node_id: normalized.entry_node_id,
      })
      .select('id')
      .single();
    if (error || !creado) {
      throw new McpToolError(
        `No se pudo crear el flujo: ${error?.message ?? 'desconocido'}`,
        'internal',
      );
    }
    flowId = creado.id as string;
  }

  const { error: graphErr } = await db.rpc('replace_flow_graph_admin', {
    p_flow_id: flowId,
    p_account_id: ctx.accountId,
    p_nodes: normalized.nodes,
    p_flow: {
      name: normalized.name,
      trigger_type: normalized.trigger_type,
      trigger_config: normalized.trigger_config,
      entry_node_id: normalized.entry_node_id,
    },
  });
  if (graphErr) {
    if (!input.flow_id) {
      await db.from('flows').delete().eq('id', flowId);
    }
    throw new McpToolError(
      `No se pudo guardar el grafo: ${graphErr.message}`,
      'internal',
    );
  }

  let status = 'draft';
  if (input.activate) {
    const { error } = await db
      .from('flows')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', flowId);
    if (error) {
      throw new McpToolError(
        `El flujo se guardó pero no se pudo activar: ${error.message}`,
        'internal',
      );
    }
    status = 'active';
  } else {
    const { data } = await db.from('flows').select('status').eq('id', flowId).maybeSingle();
    status = (data?.status as string | undefined) ?? 'draft';
  }

  return {
    saved: true,
    flow_id: flowId,
    name: normalized.name,
    status,
    activated: status === 'active',
    nodes: normalized.nodes.length,
    warnings: issues.filter((i) => i.severity === 'warning'),
    links: {
      editor: `/flows/${flowId}`,
      runs: `/flows/${flowId}/runs`,
    },
  };
}

// ------------------------------------------------------------------
// 3) Auditar rendimiento
// ------------------------------------------------------------------
export async function auditFunnelPerformance(
  ctx: McpAuthContext,
  input: { flow_id?: string; flow_name?: string; days?: number },
) {
  requireScope(ctx, 'read');
  const flow = await resolveFlow(ctx.accountId, input);
  const db = supabaseAdmin();
  const days = Math.min(Math.max(input.days ?? 30, 1), 365);
  const desde = new Date(Date.now() - days * 86_400_000).toISOString();

  const [{ data: nodes }, { data: runs }] = await Promise.all([
    db
      .from('flow_nodes')
      .select('node_key, node_type, config, position_x, position_y')
      .eq('flow_id', flow.id),
    db
      .from('flow_runs')
      .select('id, status, current_node_key, started_at, ended_at')
      .eq('flow_id', flow.id)
      .gte('started_at', desde)
      .order('started_at', { ascending: false })
      .limit(500),
  ]);

  const corridas = (runs ?? []) as Array<{
    id: string;
    status: string;
    current_node_key: string | null;
    started_at: string;
    ended_at: string | null;
  }>;
  const ids = corridas.map((r) => r.id);

  const eventos: Array<{
    flow_run_id: string;
    node_key: string | null;
    event_type: string;
    created_at: string;
  }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    const { data } = await db
      .from('flow_run_events')
      .select('flow_run_id, node_key, event_type, created_at')
      .in('flow_run_id', lote)
      .eq('event_type', 'node_entered')
      .order('created_at', { ascending: true })
      .limit(10_000);
    eventos.push(...((data ?? []) as typeof eventos));
  }

  const secuencia = new Map<string, string[]>();
  for (const ev of eventos) {
    if (!ev.node_key) continue;
    const seq = secuencia.get(ev.flow_run_id) ?? [];
    if (seq[seq.length - 1] !== ev.node_key) seq.push(ev.node_key);
    secuencia.set(ev.flow_run_id, seq);
  }

  const entradas = new Map<string, Set<string>>();
  const salidas = new Map<string, Set<string>>();
  const activos = new Map<string, number>();
  const porEstado = new Map<string, number>();

  for (const run of corridas) {
    porEstado.set(run.status, (porEstado.get(run.status) ?? 0) + 1);
    if (run.status === 'active' && run.current_node_key) {
      activos.set(
        run.current_node_key,
        (activos.get(run.current_node_key) ?? 0) + 1,
      );
    }
    const seq = secuencia.get(run.id) ?? [];
    for (const nodeKey of seq) {
      if (!entradas.has(nodeKey)) entradas.set(nodeKey, new Set());
      entradas.get(nodeKey)!.add(run.id);
    }
    for (let i = 0; i < seq.length; i += 1) {
      const esUltimo = i === seq.length - 1;
      if (esUltimo && run.status === 'active') continue;
      const nodeKey = seq[i];
      if (!salidas.has(nodeKey)) salidas.set(nodeKey, new Set());
      salidas.get(nodeKey)!.add(run.id);
    }
  }

  const metrics = ((nodes ?? []) as Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
  }>).map((n) => {
    const entra = entradas.get(n.node_key)?.size ?? 0;
    const sale = salidas.get(n.node_key)?.size ?? 0;
    return {
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config,
      entradas: entra,
      avances: sale,
      tasa: entra > 0 ? Math.round((sale / entra) * 100) : null,
      activos: activos.get(n.node_key) ?? 0,
    };
  });

  return {
    flow,
    period_days: days,
    nodes: metrics,
    runs: {
      total: corridas.length,
      por_estado: Object.fromEntries(porEstado),
    },
    truncated: corridas.length === 500,
    hint:
      'tasa = corridas que salieron del nodo / corridas que entraron. «activos» son las que siguen esperando ahí. Un nodo con muchas entradas, pocos avances y activos altos suele ser el cuello de botella.',
  };
}

// ------------------------------------------------------------------
// 4) CRM y Kanban
// ------------------------------------------------------------------
function normalizarNombre(v: unknown, campo: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new McpToolError(`Falta ${campo}.`, 'invalid_input');
  return s;
}

export async function manageCrmEntities(
  ctx: McpAuthContext,
  input: Record<string, unknown> & { action?: string },
) {
  requireScope(ctx, 'write_crm');
  const db = supabaseAdmin();
  const action = input.action;
  const w = await loadWorkspace(ctx.accountId);

  const pipeline = (ref: unknown) => {
    const name = normalizarNombre(ref, 'pipeline');
    const found = w.pipelines.filter(
      (p) => p.id === name || p.name.toLowerCase() === name.toLowerCase(),
    );
    if (found.length !== 1) {
      throw new McpToolError(
        `Embudo «${name}» no encontrado o ambiguo. Opciones: ${w.pipelines
          .map((p) => p.name)
          .join(', ')}.`,
        'invalid_input',
      );
    }
    return found[0];
  };

  const stage = (p: (typeof w.pipelines)[number], ref: unknown) => {
    const name = normalizarNombre(ref, 'stage');
    const found = p.stages.filter(
      (s) => s.id === name || s.name.toLowerCase() === name.toLowerCase(),
    );
    if (found.length !== 1) {
      throw new McpToolError(
        `Etapa «${name}» no encontrada en ${p.name}. Opciones: ${p.stages
          .map((s) => s.name)
          .join(', ')}.`,
        'invalid_input',
      );
    }
    return found[0];
  };

  switch (action) {
    case 'pipeline_create': {
      const name = normalizarNombre(input.name, 'name');
      const { data, error } = await db
        .from('pipelines')
        .insert({
          account_id: ctx.accountId,
          user_id: w.account.ownerUserId,
          name,
        })
        .select('id, name')
        .single();
      if (error) throw new McpToolError(error.message, 'internal');
      return { created: 'pipeline', pipeline: data };
    }
    case 'pipeline_rename': {
      const p = pipeline(input.pipeline);
      const name = normalizarNombre(input.new_name, 'new_name');
      const { error } = await db.from('pipelines').update({ name }).eq('id', p.id);
      if (error) throw new McpToolError(error.message, 'internal');
      return { updated: 'pipeline', id: p.id, name };
    }
    case 'stage_create': {
      const p = pipeline(input.pipeline);
      const name = normalizarNombre(input.name, 'name');
      const { data, error } = await db
        .from('pipeline_stages')
        .insert({
          pipeline_id: p.id,
          name,
          position: (input.position as number | undefined) ?? p.stages.length,
          color: (input.color as string | undefined) ?? '#3b82f6',
        })
        .select('id, name, position')
        .single();
      if (error) throw new McpToolError(error.message, 'internal');
      return { created: 'stage', stage: data };
    }
    case 'stage_update': {
      const p = pipeline(input.pipeline);
      const s = stage(p, input.stage);
      const patch: Record<string, unknown> = {};
      if (typeof input.name === 'string' && input.name.trim()) patch.name = input.name.trim();
      if (typeof input.position === 'number') patch.position = input.position;
      if (typeof input.color === 'string') patch.color = input.color;
      if (Object.keys(patch).length === 0) {
        throw new McpToolError('Nada que actualizar.', 'invalid_input');
      }
      const { error } = await db.from('pipeline_stages').update(patch).eq('id', s.id);
      if (error) throw new McpToolError(error.message, 'internal');
      return { updated: 'stage', id: s.id, ...patch };
    }
    case 'stage_reorder': {
      const p = pipeline(input.pipeline);
      const order = Array.isArray(input.order) ? (input.order as string[]) : [];
      if (order.length !== p.stages.length) {
        throw new McpToolError(
          'order debe incluir todas las etapas del embudo, en el nuevo orden.',
          'invalid_input',
        );
      }
      for (let i = 0; i < order.length; i += 1) {
        const s = stage(p, order[i]);
        await db.from('pipeline_stages').update({ position: i }).eq('id', s.id);
      }
      return { reordered: p.name, order };
    }
    case 'tag_create': {
      const name = normalizarNombre(input.name, 'name');
      const { data, error } = await db
        .from('tags')
        .insert({
          account_id: ctx.accountId,
          user_id: w.account.ownerUserId,
          name,
          color: (input.color as string | undefined) ?? '#3b82f6',
        })
        .select('id, name, color')
        .single();
      if (error) throw new McpToolError(error.message, 'internal');
      return { created: 'tag', tag: data };
    }
    case 'tag_rename': {
      const name = normalizarNombre(input.tag, 'tag');
      const found = w.tags.filter(
        (t) => t.id === name || t.name.toLowerCase() === name.toLowerCase(),
      );
      if (found.length !== 1) {
        throw new McpToolError(
          `Etiqueta «${name}» no encontrada. Opciones: ${w.tags.map((t) => t.name).join(', ')}.`,
          'invalid_input',
        );
      }
      const newName = normalizarNombre(input.new_name, 'new_name');
      const { error } = await db.from('tags').update({ name: newName }).eq('id', found[0].id);
      if (error) throw new McpToolError(error.message, 'internal');
      return { updated: 'tag', id: found[0].id, name: newName };
    }
    case 'field_create': {
      const name = normalizarNombre(input.name, 'name');
      const { data, error } = await db
        .from('custom_fields')
        .insert({
          account_id: ctx.accountId,
          user_id: w.account.ownerUserId,
          field_name: name,
          field_type: (input.type as string | undefined) ?? 'text',
          field_options: input.options ?? null,
        })
        .select('id, field_name, field_type')
        .single();
      if (error) throw new McpToolError(error.message, 'internal');
      return { created: 'custom_field', field: data };
    }
    case 'deal_create': {
      const p = pipeline(input.pipeline);
      const s = stage(p, input.stage);
      const contact = await resolveContact(ctx.accountId, {
        contact_id: input.contact_id as string | undefined,
        phone: input.phone as string | undefined,
        name: input.contact_name as string | undefined,
      });
      const { data, error } = await db
        .from('deals')
        .insert({
          account_id: ctx.accountId,
          user_id: w.account.ownerUserId,
          pipeline_id: p.id,
          stage_id: s.id,
          contact_id: contact.id,
          title:
            (typeof input.title === 'string' && input.title.trim()) ||
            contact.name ||
            contact.phone,
          value: Number(input.value) || 0,
          currency:
            typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency)
              ? input.currency
              : w.account.currency,
          notes: (input.notes as string | undefined) ?? null,
        })
        .select('id, title, value, currency, stage_id')
        .single();
      if (error) throw new McpToolError(error.message, 'internal');
      return { created: 'deal', deal: data, contact: contact.id };
    }
    case 'deal_update': {
      const dealId = normalizarNombre(input.deal_id, 'deal_id');
      const patch: Record<string, unknown> = {};
      if (typeof input.title === 'string') patch.title = input.title;
      if (input.value !== undefined) patch.value = Number(input.value) || 0;
      if (typeof input.notes === 'string') patch.notes = input.notes;
      if (typeof input.status === 'string') patch.status = input.status;
      if (Object.keys(patch).length === 0) {
        throw new McpToolError('Nada que actualizar.', 'invalid_input');
      }
      const { error } = await db
        .from('deals')
        .update(patch)
        .eq('id', dealId)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError(error.message, 'internal');
      return { updated: 'deal', id: dealId, ...patch };
    }
    case 'deal_move': {
      const dealId = normalizarNombre(input.deal_id, 'deal_id');
      const { data: deal } = await db
        .from('deals')
        .select('id, contact_id, value, currency, stage_id, pipeline_id')
        .eq('id', dealId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!deal) throw new McpToolError('Ese deal no existe.', 'not_found');
      const p = pipeline(input.pipeline ?? deal.pipeline_id);
      const s = stage(p, input.stage);
      const { error } = await db.from('deals').update({ stage_id: s.id }).eq('id', dealId);
      if (error) throw new McpToolError(error.message, 'internal');

      let capi: string | null = null;
      const pixel = await db
        .from('tracking_pixels')
        .select('purchase_stage_id')
        .eq('account_id', ctx.accountId)
        .eq('platform', 'meta')
        .eq('active', true)
        .eq('purchase_stage_id', s.id)
        .limit(1)
        .maybeSingle();
      if (pixel.data && deal.contact_id) {
        const r = await enviarEventoMeta({
          accountId: ctx.accountId,
          contactId: deal.contact_id as string,
          eventName: 'Purchase',
          eventId: `mcp-deal-${dealId}-${s.id}-${Date.now()}`,
          value: Number(deal.value) > 0 ? Number(deal.value) : undefined,
          currency: (deal.currency as string | undefined) ?? undefined,
        });
        capi = r.enviado ? 'enviado' : r.motivo;
      }
      return { moved: 'deal', id: dealId, stage: s.name, capi };
    }
    default:
      throw new McpToolError(
        `action no reconocida: ${action}. Usa pipeline_create, pipeline_rename, stage_create, stage_update, stage_reorder, tag_create, tag_rename, field_create, deal_create, deal_update o deal_move.`,
        'invalid_input',
      );
  }
}

// ------------------------------------------------------------------
// 5) Contacto: inspeccionar, pausar y responder
// ------------------------------------------------------------------
export async function inspectAndReplyContact(
  ctx: McpAuthContext,
  input: Record<string, unknown> & { action?: string },
) {
  const action = input.action;
  const db = supabaseAdmin();
  const userId = await ownerUserId(ctx.accountId);

  if (action === 'search') {
    requireScope(ctx, 'read');
    const q = normalizarNombre(input.query, 'query').replace(/[(),]/g, ' ').trim();
    const { data } = await db
      .from('contacts')
      .select('id, name, phone, updated_at')
      .eq('account_id', ctx.accountId)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .order('updated_at', { ascending: false })
      .limit(20);
    return { contacts: data ?? [] };
  }

  const contact = await resolveContact(ctx.accountId, {
    contact_id: input.contact_id as string | undefined,
    phone: input.phone as string | undefined,
    name: input.name as string | undefined,
  });

  if (action === 'history') {
    requireScope(ctx, 'read');
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 100);
    const [{ data: conv }, { data: msgs }, { data: notes }, { data: receipts }, { data: deals }, { data: attribution }, { data: runs }] =
      await Promise.all([
        db
          .from('conversations')
          .select('id, status, ai_autoreply_disabled, last_message_text, last_message_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', contact.id)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .from('messages')
          .select('sender_type, content_type, content_text, media_type, created_at, status')
          .eq('conversation_id', (
            await db
              .from('conversations')
              .select('id')
              .eq('account_id', ctx.accountId)
              .eq('contact_id', contact.id)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          ).data?.id ?? '00000000-0000-0000-0000-000000000000')
          .order('created_at', { ascending: false })
          .limit(limit),
        db
          .from('contact_notes')
          .select('note_text, created_at')
          .eq('contact_id', contact.id)
          .order('created_at', { ascending: false })
          .limit(20),
        db
          .from('payment_receipts')
          .select('monto, ultimos_digitos, banco_destino, referencia, estado, resultado, created_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', contact.id)
          .order('created_at', { ascending: false })
          .limit(20),
        db
          .from('deals')
          .select('id, title, value, currency, stage_id, pipeline_id, status')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', contact.id),
        db
          .from('contact_attribution')
          .select('source, campaign, adset, ad, utm, click_ids, ctwa_clid, first_seen_at, last_seen_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', contact.id)
          .maybeSingle(),
        db
          .from('flow_runs')
          .select('id, flow_id, status, current_node_key, started_at, flows(name)')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', contact.id)
          .order('started_at', { ascending: false })
          .limit(10),
      ]);

    return {
      contact,
      conversation: conv ?? null,
      messages: (msgs ?? []).reverse(),
      notes: notes ?? [],
      payment_receipts: receipts ?? [],
      deals: deals ?? [],
      attribution: attribution ?? null,
      flow_runs: runs ?? [],
    };
  }

  if (action === 'pause_flows' || action === 'resume_flows') {
    requireScope(ctx, 'write_flows');
    const pausar = action === 'pause_flows';
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', contact.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let corridas = 0;
    if (pausar) {
      const { data } = await db
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'mcp_pause',
        })
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active')
        .select('id');
      corridas = Array.isArray(data) ? data.length : 0;
    }
    if (conv?.id) {
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: pausar })
        .eq('id', conv.id);
    }
    return {
      contact_id: contact.id,
      paused: pausar,
      paused_runs: corridas,
      note: pausar
        ? 'Las corridas activas quedaron en paused_by_agent y la IA apagada en este chat.'
        : 'IA reactivada. El próximo mensaje del contacto puede iniciar una corrida nueva.',
    };
  }

  if (action === 'send_text') {
    requireScope(ctx, 'send_messages');
    const text = normalizarNombre(input.text, 'text');
    const conversationId = await ensureConversation(
      ctx.accountId,
      userId,
      contact.id,
    );
    try {
      const { whatsapp_message_id } = await engineSendText({
        accountId: ctx.accountId,
        userId,
        conversationId,
        contactId: contact.id,
        text,
      });
      return { sent: true, whatsapp_message_id, contact_id: contact.id };
    } catch (err) {
      throw new McpToolError(
        `No se pudo enviar: ${err instanceof Error ? err.message : String(err)}`,
        'send_failed',
      );
    }
  }

  if (action === 'send_template') {
    requireScope(ctx, 'send_messages');
    const templateName = normalizarNombre(input.template, 'template');
    const { data: tpl } = await db
      .from('message_templates')
      .select('name, language, status')
      .eq('account_id', ctx.accountId)
      .eq('name', templateName)
      .maybeSingle();
    if (!tpl || tpl.status !== 'Approved') {
      throw new McpToolError(
        `La plantilla «${templateName}» no está aprobada en esta cuenta.`,
        'not_found',
      );
    }
    const conversationId = await ensureConversation(
      ctx.accountId,
      userId,
      contact.id,
    );
    const params = Array.isArray(input.variables)
      ? (input.variables as unknown[]).map((v) => String(v))
      : undefined;
    try {
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: ctx.accountId,
        userId,
        conversationId,
        contactId: contact.id,
        templateName: tpl.name as string,
        language: (input.language as string | undefined) ?? (tpl.language as string),
        params,
      });
      return { sent: true, whatsapp_message_id, contact_id: contact.id };
    } catch (err) {
      throw new McpToolError(
        `No se pudo enviar la plantilla: ${err instanceof Error ? err.message : String(err)}`,
        'send_failed',
      );
    }
  }

  throw new McpToolError(
    'action no reconocida. Usa search, history, pause_flows, resume_flows, send_text o send_template.',
    'invalid_input',
  );
}
