import { supabaseAdmin } from '@/lib/flows/admin-client';
import { NormalizeError } from './normalizer';
import type { McpWorkspaceData } from './normalizer';
import { McpToolError } from './errors';

export interface PaymentSummary {
  configured: boolean;
  holder: string | null;
  bank: string | null;
  clabeLast4: string | null;
  oxxo: string | null;
  mensaje: string | null;
  activo: boolean;
}

export interface Workspace extends McpWorkspaceData {
  account: {
    id: string;
    name: string;
    currency: string;
    ownerUserId: string;
  };
  fields: Array<{ id: string; name: string; type: string; options: unknown }>;
  payment: PaymentSummary;
  tracking: {
    metaPixelId: string | null;
    purchaseStageId: string | null;
  };
  flows: Array<{
    id: string;
    name: string;
    status: string;
    trigger_type: string;
  }>;
}

const MAX_NAME_MATCHES = 10;

function maskClabe(clabe: string | null): string | null {
  if (!clabe) return null;
  const limpio = clabe.replace(/\s/g, '');
  if (limpio.length <= 4) return '••••';
  return `•••• ${limpio.slice(-4)}`;
}

export async function ownerUserId(accountId: string): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data?.owner_user_id) {
    throw new McpToolError('No se encontró la cuenta de la credencial.', 'not_found');
  }
  return data.owner_user_id as string;
}

export async function loadWorkspace(accountId: string): Promise<Workspace> {
  const db = supabaseAdmin();
  const [
    accountRes,
    pipelinesRes,
    stagesRes,
    tagsRes,
    fieldsRes,
    templatesRes,
    paymentRes,
    pixelRes,
    flowsRes,
  ] = await Promise.all([
    db
      .from('accounts')
      .select('id, name, default_currency, owner_user_id')
      .eq('id', accountId)
      .maybeSingle(),
    db
      .from('pipelines')
      .select('id, name')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true }),
    db
      .from('pipeline_stages')
      .select('id, pipeline_id, name, position, color')
      .order('position', { ascending: true }),
    db
      .from('tags')
      .select('id, name, color')
      .eq('account_id', accountId)
      .order('name', { ascending: true }),
    db
      .from('custom_fields')
      .select('id, field_name, field_type, field_options')
      .eq('account_id', accountId)
      .order('field_name', { ascending: true }),
    db
      .from('message_templates')
      .select('id, name, language, category, status')
      .eq('account_id', accountId)
      .eq('status', 'Approved')
      .order('name', { ascending: true }),
    db
      .from('payment_details')
      .select('holder, bank, clabe, oxxo, mensaje, activo')
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('tracking_pixels')
      .select('pixel_id, purchase_stage_id, access_token')
      .eq('account_id', accountId)
      .eq('platform', 'meta')
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    db
      .from('flows')
      .select('id, name, status, trigger_type')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
      .limit(200),
  ]);

  if (!accountRes.data) {
    throw new McpToolError('No se encontró la cuenta de la credencial.', 'not_found');
  }

  const pipelineIds = (pipelinesRes.data ?? []).map((p) => p.id as string);
  const stages = (stagesRes.data ?? []).filter((s) =>
    pipelineIds.includes(s.pipeline_id as string),
  );

  const pipelines = (pipelinesRes.data ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    stages: stages
      .filter((s) => s.pipeline_id === p.id)
      .map((s) => ({
        id: s.id as string,
        name: s.name as string,
        position: Number(s.position) || 0,
      })),
  }));

  const payment = paymentRes.data;
  return {
    account: {
      id: accountRes.data.id as string,
      name: (accountRes.data.name as string) ?? '',
      currency: (accountRes.data.default_currency as string) ?? 'USD',
      ownerUserId: accountRes.data.owner_user_id as string,
    },
    pipelines,
    tags: (tagsRes.data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
    })),
    templates: (templatesRes.data ?? []).map((t) => ({
      name: t.name as string,
      language: (t.language as string) ?? 'es_MX',
    })),
    fields: (fieldsRes.data ?? []).map((f) => ({
      id: f.id as string,
      name: f.field_name as string,
      type: f.field_type as string,
      options: f.field_options,
    })),
    payment: {
      configured: Boolean(payment),
      holder: (payment?.holder as string | null) ?? null,
      bank: (payment?.bank as string | null) ?? null,
      clabeLast4: maskClabe((payment?.clabe as string | null) ?? null),
      oxxo: (payment?.oxxo as string | null) ?? null,
      mensaje: (payment?.mensaje as string | null) ?? null,
      activo: Boolean(payment?.activo),
    },
    tracking: {
      metaPixelId: (pixelRes.data?.pixel_id as string | null) ?? null,
      purchaseStageId:
        (pixelRes.data?.purchase_stage_id as string | null) ?? null,
    },
    flows: (flowsRes.data ?? []).map((f) => ({
      id: f.id as string,
      name: f.name as string,
      status: f.status as string,
      trigger_type: f.trigger_type as string,
    })),
  };
}

export async function resolveFlow(
  accountId: string,
  input: { flow_id?: string; flow_name?: string },
): Promise<{ id: string; name: string; status: string }> {
  const db = supabaseAdmin();
  if (input.flow_id) {
    const { data } = await db
      .from('flows')
      .select('id, name, status')
      .eq('id', input.flow_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!data) throw new McpToolError('Ese flujo no existe en la cuenta.', 'not_found');
    return { id: data.id as string, name: data.name as string, status: data.status as string };
  }
  const nombre = (input.flow_name ?? '').trim();
  if (!nombre) {
    throw new McpToolError('Indica flow_id o flow_name.', 'invalid_input');
  }
  const { data } = await db
    .from('flows')
    .select('id, name, status')
    .eq('account_id', accountId)
    .ilike('name', nombre)
    .limit(MAX_NAME_MATCHES);
  const filas = data ?? [];
  if (filas.length === 0) {
    throw new McpToolError(`No hay un flujo llamado «${nombre}».`, 'not_found');
  }
  if (filas.length > 1) {
    throw new McpToolError(
      `Hay varios flujos con ese nombre: ${filas.map((f) => f.id).join(', ')}. Usa flow_id.`,
      'invalid_input',
    );
  }
  const f = filas[0];
  return { id: f.id as string, name: f.name as string, status: f.status as string };
}

export async function resolveContact(
  accountId: string,
  input: { contact_id?: string; phone?: string; name?: string },
): Promise<{ id: string; name: string | null; phone: string }> {
  const db = supabaseAdmin();
  if (input.contact_id) {
    const { data } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', input.contact_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!data) throw new McpToolError('Ese contacto no existe en la cuenta.', 'not_found');
    return { id: data.id as string, name: (data.name as string) ?? null, phone: data.phone as string };
  }
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '');
    const { data } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', accountId)
      .in('phone', [input.phone.trim(), digits])
      .limit(1)
      .maybeSingle();
    if (!data) throw new McpToolError('No hay un contacto con ese teléfono.', 'not_found');
    return { id: data.id as string, name: (data.name as string) ?? null, phone: data.phone as string };
  }
  const nombre = (input.name ?? '').trim();
  if (!nombre) throw new McpToolError('Indica contact_id, phone o name.', 'invalid_input');
  const { data } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .ilike('name', `%${nombre}%`)
    .limit(MAX_NAME_MATCHES);
  const filas = data ?? [];
  if (filas.length === 0) throw new McpToolError(`No hay contactos con «${nombre}».`, 'not_found');
  if (filas.length > 1) {
    throw new McpToolError(
      `Hay varios contactos; usa contact_id: ${filas
        .map((c) => `${c.id} (${c.name ?? c.phone})`)
        .join(', ')}.`,
      'invalid_input',
    );
  }
  const c = filas[0];
  return { id: c.id as string, name: (c.name as string) ?? null, phone: c.phone as string };
}

export async function ensureConversation(
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string> {
  const db = supabaseAdmin();
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.id) return data.id as string;

  const { data: creada, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      status: 'open',
    })
    .select('id')
    .single();
  if (error || !creada) {
    throw new McpToolError(
      `No se pudo abrir la conversación: ${error?.message ?? 'desconocido'}`,
      'internal',
    );
  }
  return creada.id as string;
}

export function rethrowNormalize(err: unknown): never {
  if (err instanceof NormalizeError) {
    throw new McpToolError(err.message, 'invalid_input');
  }
  throw err;
}
