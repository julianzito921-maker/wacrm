/**
 * Normalizador del despliegue MCP: acepta un embudo "amigable" (nombres,
 * duraciones, mensajes) y lo convierte en los nodos exactos del editor.
 *
 * Objetivo: que Claude no tenga que conocer IDs ni claves internas. Los
 * nombres de embudo/etapa/etiqueta/plantilla se resuelven contra el
 * workspace; los `next` pueden ser claves o índices 0-based y se
 * autogeneran si faltan.
 */

import type { BurbujaMensaje, TipoBurbuja } from '@/lib/flows/types';

export interface WorkspacePipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string; position: number }>;
}

export interface McpWorkspaceData {
  pipelines: WorkspacePipeline[];
  tags: Array<{ id: string; name: string }>;
  templates: Array<{ name: string; language: string }>;
}

export interface FlowNodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

export interface FriendlyBubble {
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'interval';
  text?: string;
  /** Alias de text para pies de foto. */
  caption?: string;
  url?: string;
  filename?: string;
  seconds?: number;
  like?: boolean;
}

interface BaseNode {
  key?: string;
  next?: string | number;
}

export type FriendlyNode =
  | (BaseNode & { type: 'start' })
  | (BaseNode & { type: 'message'; messages: FriendlyBubble[] })
  | (BaseNode & { type: 'wait'; seconds?: number; duration?: string })
  | (BaseNode & {
      type: 'wait_reply';
      var?: string;
      prompt?: string;
      wait?: number | string;
      indefinite?: boolean;
      buffer_seconds?: number;
      quote?: boolean;
      react?: boolean;
      contact_field?: string;
      no_reply_next?: string | number;
    })
  | (BaseNode & {
      type: 'payment';
      amount: number;
      message?: string;
      wait_minutes?: number;
      approve_tag?: string;
      button?: boolean;
      approved_next?: string | number;
      rejected_next?: string | number;
    })
  | (BaseNode & {
      type: 'capi';
      event: 'Purchase' | 'Lead' | 'InitiateCheckout' | 'AddToCart' | 'ViewContent';
      value?: number;
      currency?: string;
    })
  | (BaseNode & {
      type: 'kanban';
      pipeline: string;
      stage: string;
      create_if_missing?: boolean;
      title?: string;
    })
  | (BaseNode & { type: 'tag'; tag: string; mode?: 'add' | 'remove' })
  | (BaseNode & {
      type: 'template';
      template: string;
      language?: string;
      variables?: Record<string, string> | string[];
    })
  | (BaseNode & { type: 'end' })
  | (BaseNode & {
      type: 'raw';
      node_type: string;
      config: Record<string, unknown>;
      next_fields?: string[];
    });

export interface FriendlyFunnel {
  name: string;
  trigger?: {
    type?: 'keyword' | 'first_inbound_message' | 'any_message';
    keywords?: string[];
    match_type?: 'contains' | 'exact';
  };
  nodes: FriendlyNode[];
}

export interface NormalizedFunnel {
  name: string;
  trigger_type: 'keyword' | 'first_inbound_message' | 'any_message';
  trigger_config: Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowNodeInput[];
}

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

const MAX_WAIT = 23 * 3600;

export function parseDuration(
  value: number | string | undefined,
  fallback: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(Math.round(value), MAX_WAIT));
  }
  if (typeof value === 'string' && value.trim()) {
    const texto = value.trim().toLowerCase();
    let total = 0;
    let restante = texto;
    const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(texto)) !== null) {
      const n = Number(m[1]);
      total +=
        n *
        (m[2] === 'd' ? 86_400 : m[2] === 'h' ? 3_600 : m[2] === 'm' ? 60 : 1);
      restante = restante.replace(m[0], '');
    }
    if (total > 0) return Math.min(Math.round(total), MAX_WAIT);
    if (/^\d+$/.test(texto)) return Math.min(Number(texto), MAX_WAIT);
    if (restante.trim()) throw new NormalizeError(`Duración no válida: ${value}`);
  }
  return fallback;
}

function resolverNombre<T extends { name: string }>(
  lista: T[],
  buscado: string,
  etiqueta: string,
): T {
  const normal = buscado.trim().toLowerCase();
  const exacto = lista.filter((x) => x.name.toLowerCase() === normal);
  if (exacto.length === 1) return exacto[0];
  if (exacto.length > 1) {
    throw new NormalizeError(`${etiqueta} «${buscado}» es ambiguo.`);
  }
  const opciones = lista.slice(0, 10).map((x) => x.name).join(', ');
  throw new NormalizeError(
    `${etiqueta} «${buscado}» no existe. Opciones: ${opciones || 'ninguna'}.`,
  );
}

function normalizarBurbujas(messages: FriendlyBubble[]): BurbujaMensaje[] {
  if (messages.length === 0) {
    throw new NormalizeError('El mensaje necesita al menos una burbuja.');
  }
  const items: BurbujaMensaje[] = [];
  for (const b of messages) {
    const tipo = b.type;
    if (tipo === 'interval') {
      const segundos = b.seconds ?? 1;
      if (segundos < 1 || segundos > MAX_WAIT) {
        throw new NormalizeError('El intervalo debe durar entre 1 s y 23 h.');
      }
      items.push({ tipo: 'interval', segundos: Math.round(segundos) });
      continue;
    }
    if (tipo === 'text' && !b.text?.trim()) {
      throw new NormalizeError('Una burbuja de texto no puede ir vacía.');
    }
    if (tipo !== 'text' && !b.url) {
      throw new NormalizeError(`La burbuja ${tipo} necesita url.`);
    }
    const segundos = Math.max(0, Math.min(Math.round(b.seconds ?? 0), MAX_WAIT));
    if (segundos > 60) {
      items.push({ tipo: 'interval', segundos });
    }
    items.push({
      tipo: tipo as TipoBurbuja,
      text: b.text ?? b.caption,
      media_url: tipo === 'text' ? undefined : b.url,
      filename: tipo === 'document' ? b.filename : undefined,
      segundos: segundos > 60 ? 0 : segundos,
      like: b.like === true ? true : undefined,
    });
  }
  return items;
}

function resolverDestino(
  ref: string | number | undefined,
  idx: number,
  claves: string[],
  porDefecto: string,
): string {
  if (ref === undefined) return porDefecto;
  if (typeof ref === 'number') {
    const clave = claves[ref];
    if (!clave) throw new NormalizeError(`El índice de nodo ${ref} no existe.`);
    return clave;
  }
  const limpio = ref.trim();
  if (!limpio) return '';
  if (claves.includes(limpio)) return limpio;
  throw new NormalizeError(`El nodo «${limpio}» no existe (desde el nodo ${idx + 1}).`);
}

export function normalizeFunnel(
  funnel: FriendlyFunnel,
  workspace: McpWorkspaceData,
): NormalizedFunnel {
  if (!funnel.name?.trim()) throw new NormalizeError('El flujo necesita nombre.');
  if (funnel.nodes.length === 0) {
    throw new NormalizeError('El flujo necesita al menos un nodo.');
  }

  const hayStart = funnel.nodes.some((n) => n.type === 'start');
  const entradaNodos: FriendlyNode[] = hayStart
    ? funnel.nodes
    : [{ type: 'start' }, ...funnel.nodes];
  const claves = entradaNodos.map((n, i) => {
    const clave = n.key?.trim();
    return clave || `n${i + 1}`;
  });
  const set = new Set(claves);
  if (set.size !== claves.length) {
    throw new NormalizeError('Hay claves de nodo repetidas.');
  }

  // Un fin implícito solo si hace falta y no hay un `end` explícito.
  const endIdx = entradaNodos.findIndex((n) => n.type === 'end');
  const hayEnd = endIdx >= 0;
  const necesitaFin =
    !hayEnd &&
    entradaNodos.some(
      (n) =>
        (n.type === 'wait_reply' &&
          !n.indefinite &&
          n.no_reply_next === undefined) ||
        (n.type === 'payment' && n.rejected_next === undefined),
    );
  const clavesFinales = necesitaFin ? [...claves, 'fin'] : claves;
  const tipos = [...entradaNodos, ...(necesitaFin ? [{ type: 'end' as const }] : [])];
  const endKey = hayEnd ? claves[endIdx] : necesitaFin ? 'fin' : '';

  const startIdx = entradaNodos.findIndex((n) => n.type === 'start');

  const nodos: FlowNodeInput[] = [];
  const usadasVar = new Set<string>();
  let turno = 0;

  tipos.forEach((n, i) => {
    const key = clavesFinales[i];
    const siguiente =
      i + 1 < clavesFinales.length ? clavesFinales[i + 1] : '';
    const fin = endKey;
    const pos = { position_x: 0, position_y: i * 170 };

    const crear = (node_type: string, config: Record<string, unknown>) => {
      nodos.push({ node_key: key, node_type, config, ...pos });
    };

    switch (n.type) {
      case 'start': {
        crear('start', {
          next_node_key: resolverDestino(
            (n as BaseNode).next,
            i,
            clavesFinales,
            siguiente,
          ),
        });
        break;
      }
      case 'message': {
        crear('send_message', {
          text: '',
          items: normalizarBurbujas(n.messages),
          next_node_key: resolverDestino(
            n.next,
            i,
            clavesFinales,
            siguiente,
          ),
        });
        break;
      }
      case 'wait': {
        const segundos = n.duration
          ? parseDuration(n.duration, 5)
          : parseDuration(n.seconds, 5);
        crear('wait', {
          segundos,
          next_node_key: resolverDestino(n.next, i, clavesFinales, siguiente),
        });
        break;
      }
      case 'wait_reply': {
        turno += 1;
        let varKey = (n.var ?? `respuesta_${turno}`)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .trim();
        if (!varKey) varKey = `respuesta_${turno}`;
        while (usadasVar.has(varKey)) varKey = `${varKey}_${turno}`;
        usadasVar.add(varKey);
        const indefinido = n.indefinite === true;
        const segundos = indefinido
          ? 86_400
          : parseDuration(n.wait, 86_400);
        crear('save_reply', {
          prompt_text: n.prompt ?? '',
          var_key: varKey,
          espera_segundos: segundos,
          espera_minutos: Math.max(1, Math.ceil(segundos / 60)),
          esperar_indefinido: indefinido,
          buffer_segundos: Math.min(Math.max(n.buffer_seconds ?? 0, 0), 120),
          citar_respuesta: n.quote === true,
          reaccionar: n.react === true,
          campo_contacto: n.contact_field ?? '',
          contesto_next: resolverDestino(n.next, i, clavesFinales, siguiente),
          no_contesto_next: indefinido
            ? ''
            : resolverDestino(n.no_reply_next, i, clavesFinales, fin),
        });
        break;
      }
      case 'payment': {
        if (!(n.amount > 0)) {
          throw new NormalizeError('El pago necesita un monto mayor que 0.');
        }
        crear('send_payment', {
          monto: n.amount,
          mensaje: n.message,
          con_boton: n.button === true,
          espera_minutos: Math.min(Math.max(n.wait_minutes ?? 1_440, 1), 1_380),
          etiqueta_al_aprobar: n.approve_tag ?? 'pagado',
          aprobado_next: resolverDestino(
            n.approved_next,
            i,
            clavesFinales,
            siguiente,
          ),
          rechazado_next: resolverDestino(
            n.rejected_next,
            i,
            clavesFinales,
            fin,
          ),
        });
        break;
      }
      case 'capi': {
        if (n.event === 'Purchase' && !(Number(n.value) > 0)) {
          throw new NormalizeError('Purchase necesita value.');
        }
        crear('meta_capi', {
          event_name: n.event,
          value: n.value,
          currency: n.currency,
          next_node_key: resolverDestino(n.next, i, clavesFinales, siguiente),
        });
        break;
      }
      case 'kanban': {
        const pipeline = resolverNombre(workspace.pipelines, n.pipeline, 'Embudo');
        const stage = resolverNombre(
          pipeline.stages.map((s) => ({ ...s, name: s.name })),
          n.stage,
          `Etapa de ${pipeline.name}`,
        );
        crear('move_kanban', {
          pipeline_id: pipeline.id,
          stage_id: stage.id,
          crear_si_no_existe: n.create_if_missing !== false,
          titulo: n.title,
          next_node_key: resolverDestino(n.next, i, clavesFinales, siguiente),
        });
        break;
      }
      case 'tag': {
        const tag = resolverNombre(workspace.tags, n.tag, 'Etiqueta');
        crear('set_tag', {
          mode: n.mode ?? 'add',
          tag_id: tag.id,
          next_node_key: resolverDestino(n.next, i, clavesFinales, siguiente),
        });
        break;
      }
      case 'template': {
        const tpl = resolverNombre(
          workspace.templates,
          n.template,
          'Plantilla aprobada',
        );
        const variables = Array.isArray(n.variables)
          ? Object.fromEntries(
              n.variables.map((v, idx) => [String(idx + 1), String(v)]),
            )
          : (n.variables ?? {});
        crear('send_template', {
          template_name: tpl.name,
          language: n.language ?? tpl.language,
          variables,
          next_node_key: resolverDestino(n.next, i, clavesFinales, siguiente),
        });
        break;
      }
      case 'end': {
        crear('end', {});
        break;
      }
      case 'raw': {
        const config = { ...n.config };
        if (n.next !== undefined) {
          const campos = n.next_fields ?? ['next_node_key'];
          for (const campo of campos) {
            config[campo] = resolverDestino(
              n.next,
              i,
              clavesFinales,
              siguiente,
            );
          }
        }
        crear(n.node_type, config);
        break;
      }
      default:
        throw new NormalizeError('Tipo de nodo no soportado.');
    }
  });

  const trigger = funnel.trigger ?? {};
  const trigger_type =
    trigger.type ??
    ((trigger.keywords?.length ?? 0) > 0 ? 'keyword' : 'any_message');
  if (!['keyword', 'first_inbound_message', 'any_message'].includes(trigger_type)) {
    throw new NormalizeError('trigger.type no válido.');
  }
  let trigger_config: Record<string, unknown> = {};
  if (trigger_type === 'keyword') {
    const keywords = (trigger.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    if (keywords.length === 0) {
      throw new NormalizeError(
        'Un disparador keyword necesita al menos una palabra clave.',
      );
    }
    trigger_config = {
      keywords,
      match_type: trigger.match_type === 'exact' ? 'exact' : 'contains',
    };
  }

  const entry = clavesFinales[startIdx];
  return {
    name: funnel.name.trim(),
    trigger_type,
    trigger_config,
    entry_node_id: entry,
    nodes: nodos,
  };
}
