/**
 * Shared editor primitives used by both the linear-list and canvas
 * views of a flow.
 *
 * What lives here vs in flow-builder.tsx / flow-canvas.tsx:
 *   - Types and metadata that BOTH views need to render a node
 *     consistently (icon, label, color, 1-line summary).
 *   - Editing-only helpers (defaultConfigFor, slugify, uniqueNodeKey,
 *     BuilderState) stay in flow-builder.tsx until the canvas grows
 *     editing affordances — pulled across in the PR that adds them.
 *
 * Why .tsx and not .ts: NODE_META holds lucide icon components, which
 * are typed as React components; importing them from a .ts module
 * works at runtime but trips TypeScript's
 * `verbatimModuleSyntax`-related linting in some setups. Keeping the
 * file .tsx future-proofs it for inline JSX in node-card renderers.
 */

import {
  Bell,
  Bot,
  Building2,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Kanban,
  LayoutGrid,
  List,
  MessageCircle,
  MessageSquare,
  Mic,
  PhoneCall,
  Play,
  Save,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Target,
  Video,
  Workflow,
} from 'lucide-react';

import { cn } from '@/lib/utils';

// ============================================================
// Node-type union — single source of truth for every place the UI
// enumerates types (add menu, type pickers, switch statements). Kept
// in lockstep with `FlowNodeType` in src/lib/flows/types.ts (which
// drives the engine's exhaustiveness check); a divergence between the
// two is always a bug.
// ============================================================

export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'collect_input'
  | 'wait'
  | 'save_reply'
  | 'condition'
  | 'set_tag'
  | 'handoff'
  | 'meta_capi'
  | 'send_payment'
  | 'send_template'
  | 'move_kanban'
  | 'connect_flow'
  | 'ai_block'
  | 'manipulator'
  | 'distributor'
  | 'notification'
  | 'sale_approved'
  | 'carousel'
  | 'department'
  | 'http_request'
  | 'payment_gateway'
  | 'ai_media'
  | 'official_call'
  | 'end';

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}

// ============================================================
// Per-node-type metadata used to render icons + colours everywhere
// the user sees a node summary. The user-visible label and blurb live
// in the message catalogue (`Flows.builder.nodes.<type>` /
// `Flows.builder.categories.<id>`), not here.
// ============================================================

// ------------------------------------------------------------
// Node categories — buckets the add-step menu groups types under so
// the picker stays scannable as the type list grows, and so a fork
// adding its own node types has an obvious place to slot them.
//
// Note there's no "Events / Triggers" category: in wacrm a flow is
// triggered by flow-level config (`trigger_type`), not by a node on
// the canvas, so `start` is just the entry point under Flow control.
// ------------------------------------------------------------

export type NodeCategory = 'messaging' | 'logic' | 'flow';

/** The order categories render in the add-step menu. */
export const NODE_CATEGORIES: NodeCategory[] = ['messaging', 'logic', 'flow'];

export const NODE_META: Record<
  NodeType,
  {
    /** English seed for the auto-generated node_key (`slugify(slugSeed)`).
     *  Deliberately NOT translated: node keys are stable identifiers that
     *  surface in analytics and the runner, so they must not change with
     *  the UI locale. */
    slugSeed: string;
    icon: typeof Workflow;
    color: string;
    category: NodeCategory;
  }
> = {
  start: {
    slugSeed: 'Start',
    icon: Play,
    color: 'text-emerald-400',
    category: 'flow',
  },
  send_message: {
    slugSeed: 'Send message',
    icon: MessageSquare,
    color: 'text-sky-400',
    category: 'messaging',
  },
  send_buttons: {
    slugSeed: 'Send buttons',
    icon: List,
    color: 'text-primary',
    category: 'messaging',
  },
  send_list: {
    slugSeed: 'Send list',
    icon: List,
    color: 'text-indigo-400',
    category: 'messaging',
  },
  send_media: {
    slugSeed: 'Send media',
    icon: MessageSquare,
    color: 'text-cyan-400',
    category: 'messaging',
  },
  collect_input: {
    slugSeed: 'Collect input',
    icon: Save,
    color: 'text-teal-400',
    category: 'logic',
  },
  condition: {
    slugSeed: 'If / else',
    icon: GitBranch,
    color: 'text-fuchsia-400',
    category: 'logic',
  },
  wait: {
    slugSeed: 'Wait',
    icon: Clock,
    color: 'text-orange-400',
    category: 'flow',
  },
  save_reply: {
    slugSeed: 'Save reply',
    icon: Save,
    color: 'text-teal-400',
    category: 'logic',
  },
  set_tag: {
    slugSeed: 'Tag contact',
    icon: Tag,
    color: 'text-pink-400',
    category: 'logic',
  },
  send_payment: {
    slugSeed: 'Pago SPEI',
    icon: CreditCard,
    color: 'text-violet-400',
    category: 'messaging',
  },
  send_template: {
    slugSeed: 'Template',
    icon: FileText,
    color: 'text-violet-400',
    category: 'messaging',
  },
  move_kanban: {
    slugSeed: 'Kanban',
    icon: Kanban,
    color: 'text-sky-400',
    category: 'logic',
  },
  connect_flow: {
    slugSeed: 'Connect flow',
    icon: Share2,
    color: 'text-indigo-400',
    category: 'flow',
  },
  ai_block: {
    slugSeed: 'AI block',
    icon: Bot,
    color: 'text-violet-400',
    category: 'logic',
  },
  meta_capi: {
    slugSeed: 'Meta CAPI',
    icon: Target,
    color: 'text-blue-400',
    category: 'logic',
  },
  handoff: {
    slugSeed: 'Handoff to agent',
    icon: MessageCircle,
    color: 'text-amber-400',
    category: 'flow',
  },
  manipulator: {
    slugSeed: 'Manipulador',
    icon: SlidersHorizontal,
    color: 'text-orange-400',
    category: 'logic',
  },
  distributor: {
    slugSeed: 'Distribuidor',
    icon: GitBranch,
    color: 'text-amber-400',
    category: 'flow',
  },
  notification: {
    slugSeed: 'Notificación',
    icon: Bell,
    color: 'text-teal-400',
    category: 'messaging',
  },
  sale_approved: {
    slugSeed: 'Venta aprobada',
    icon: DollarSign,
    color: 'text-emerald-400',
    category: 'logic',
  },
  carousel: {
    slugSeed: 'Carrusel',
    icon: LayoutGrid,
    color: 'text-blue-400',
    category: 'messaging',
  },
  department: {
    slugSeed: 'Departamento',
    icon: Building2,
    color: 'text-cyan-400',
    category: 'flow',
  },
  http_request: {
    slugSeed: 'Integracion HTTP',
    icon: Globe,
    color: 'text-violet-400',
    category: 'logic',
  },
  payment_gateway: {
    slugSeed: 'Pasarela de pago',
    icon: CreditCard,
    color: 'text-emerald-400',
    category: 'messaging',
  },
  ai_media: {
    slugSeed: 'Multimedia IA',
    icon: Sparkles,
    color: 'text-fuchsia-400',
    category: 'messaging',
  },
  official_call: {
    slugSeed: 'Llamada oficial',
    icon: PhoneCall,
    color: 'text-sky-400',
    category: 'flow',
  },
  end: {
    slugSeed: 'End',
    icon: Bot,
    color: 'text-muted-foreground',
    category: 'flow',
  },
};

/**
 * Bucket an ordered list of node types by category, preserving both
 * the category order (NODE_CATEGORIES) and the within-category order
 * of the input list. Empty categories are dropped. Used by both the
 * canvas and list add-step menus so they stay in lockstep.
 */
export function groupNodeTypesByCategory(
  types: NodeType[]
): { id: NodeCategory; types: NodeType[] }[] {
  return NODE_CATEGORIES.map((id) => ({
    id,
    types: types.filter((t) => NODE_META[t].category === id),
  })).filter((group) => group.types.length > 0);
}

// ============================================================
// Per-node-type color system.
//
// Each node type gets its own hue so the canvas reads at a glance —
// what KIND of step is this. Kept as raw oklch (not Tailwind classes)
// so a node card can tint its icon chip, type label, selection ring,
// and edge ports from one source, the way the Flow Builder design
// handoff does. Hues sit in the same oklch family as the app tokens
// in globals.css; they don't replace --primary (the accent), they
// complement it. `nodeColors()` derives the soft/ring/text variants.
// ============================================================

// Rediseño del 22-nov-2026: el color sigue a la CATEGORÍA del bloque.
//   morado  → mensajes (lo que se le manda a la clienta)
//   ámbar   → esperas y condiciones
//   turquesa→ Meta CAPI / conversiones
//   azul    → IA y control del chat
/**
 * Colores de cada bloque, iguales a Leona: degradado de izquierda a
 * derecha en el marco y la cabecera de la tarjeta (`from` → `to`).
 */
export const LEONA_COLOR: Record<NodeType, { from: string; to: string }> = {
  start: { from: '#22c55e', to: '#16a34a' }, // verde
  send_message: { from: '#3b82f6', to: '#2563eb' }, // azul — Mensaje
  send_media: { from: '#3b82f6', to: '#2563eb' },
  send_template: { from: '#1d4ed8', to: '#1e40af' }, // azul profundo — Template
  set_tag: { from: '#6366f1', to: '#4f46e5' }, // índigo — Etiquetas
  send_payment: { from: '#10b981', to: '#059669' }, // esmeralda — Botón de pago
  send_buttons: { from: '#a855f7', to: '#9333ea' }, // morado — Menú
  send_list: { from: '#a855f7', to: '#9333ea' },
  carousel: { from: '#0ea5e9', to: '#0284c7' }, // celeste — Carrusel
  save_reply: { from: '#f97316', to: '#ea580c' }, // naranja — Esperar respuesta
  collect_input: { from: '#f97316', to: '#ea580c' },
  handoff: { from: '#64748b', to: '#475569' }, // pizarra — Controlador de chat
  notification: { from: '#14b8a6', to: '#0d9488' }, // verde azulado — Notificación
  condition: { from: '#38bdf8', to: '#0ea5e9' }, // celeste — Condicional
  distributor: { from: '#f59e0b', to: '#d97706' }, // ámbar — Distribuidor
  connect_flow: { from: '#f43f5e', to: '#e11d48' }, // rosa — Conexión de flujo
  meta_capi: { from: '#eab308', to: '#ca8a04' }, // amarillo — Pixel
  wait: { from: '#06b6d4', to: '#0891b2' }, // cian — Intervalo inteligente
  department: { from: '#8b5cf6', to: '#7c3aed' }, // violeta — Departamento
  http_request: { from: '#3b82f6', to: '#2563eb' }, // azul — Integración
  ai_block: { from: '#10b981', to: '#059669' }, // esmeralda — Bloque de IA
  end: { from: '#8b5cf6', to: '#7c3aed' }, // violeta — Agente de IA
  move_kanban: { from: '#a855f7', to: '#9333ea' }, // morado — Kanban
  manipulator: { from: '#f97316', to: '#ea580c' }, // naranja — Manipulador
  sale_approved: { from: '#70f68d', to: '#22c55e' }, // verde neón — Venta aprobada
  payment_gateway: { from: '#8b5cf6', to: '#7c3aed' }, // violeta — Pago
  official_call: { from: '#14b8a6', to: '#0d9488' }, // verde azulado — Llamar
  ai_media: { from: '#d946ef', to: '#c026d3' }, // fucsia — Multimedia IA
};

/** `linear-gradient(to right, from, to)` del bloque. */
export function degradado(type: NodeType): string {
  const c = LEONA_COLOR[type];
  return `linear-gradient(to right, ${c.from}, ${c.to})`;
}

export interface NodeColors {
  /** Full-strength hue — icon glyph, selection ring, port fill. */
  solid: string;
  /** ~14% tint — icon chip background, soft fills. */
  soft: string;
  /** ~45% tint — hover border / focus ring. */
  ring: string;
  /** Hue for the uppercase type label, kept readable in BOTH modes. */
  text: string;
}

export function nodeColors(type: NodeType): NodeColors {
  const solid = LEONA_COLOR[type].from;
  return {
    solid,
    soft: `color-mix(in srgb, ${solid} 14%, transparent)`,
    ring: `color-mix(in srgb, ${solid} 45%, transparent)`,
    // Blend the hue toward the live --foreground token so the label
    // holds contrast in BOTH modes: in dark mode --foreground is
    // near-white (the label lightens to read on the dark card), in
    // light mode it's near-black (the label darkens to read on the
    // white card). The old fixed-light value only worked on dark.
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}

// ============================================================
// Shared node icon chip — the per-type colored glyph badge used in
// the canvas node card, list-view card, inspector header, and the
// add-step menu. One component so a styling change (radius, contrast,
// hover) lands in every place at once and the `nodeColors()` lookup
// lives in exactly one spot.
// ============================================================

export function NodeIconChip({
  type,
  size = 24,
  iconSize = 14,
  className,
}: {
  type: NodeType;
  /** Chip side length in px. */
  size?: number;
  /** Glyph side length in px. */
  iconSize?: number;
  className?: string;
}) {
  const meta = NODE_META[type];
  const c = nodeColors(type);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        className
      )}
      style={{ width: size, height: size, background: c.soft, color: c.solid }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

// ============================================================
// Pure editing helpers — used by forms in both views.
// ============================================================

/**
 * Coerce an arbitrary string into a stable identifier (node_key,
 * reply_id, etc.). Lowercases, collapses non-alphanumerics into
 * single underscores, and trims leading/trailing underscores. Falls
 * back to `fallback` for inputs that reduce to an empty string.
 */
export function slugify(s: string, fallback: string): string {
  const cleaned = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

// ============================================================
// Summary helpers — short, single-line content previews used in
// collapsed node cards (list view) and node tiles (canvas view).
// Returns null when there's nothing meaningful to show (start/end,
// or a freshly-added node with no fields filled in).
// ============================================================

export function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

/**
 * «1 día», «30 minutos», «45 s»: el tiempo de «Esperar respuesta» en la
 * unidad más grande que lo represente exacto.
 */
export function formatearEspera(
  segundos: number,
  t?: (key: string, values?: Record<string, string | number>) => string
): string {
  const s = Math.max(0, Math.round(segundos));
  const fmt = (n: number, unidad: 'Days' | 'Hours' | 'Minutes' | 'Seconds') =>
    t ? t(`wait${unidad}`, { count: n }) : `${n} ${unidad.slice(0, 1).toLowerCase()}`;
  if (s > 0 && s % 86400 === 0) return fmt(s / 86400, 'Days');
  if (s > 0 && s % 3600 === 0) return fmt(s / 3600, 'Hours');
  if (s > 0 && s % 60 === 0) return fmt(s / 60, 'Minutes');
  return fmt(s, 'Seconds');
}

export function summarizeNode(
  node: BuilderNode,
  t?: (key: string, values?: Record<string, string | number>) => string
): string | null {
  const cfg = node.config;
  switch (node.node_type) {
    case 'start':
    case 'connect_flow':
      return typeof cfg.target_flow_id === 'string' && cfg.target_flow_id
        ? cfg.target_flow_id
        : null;
    case 'ai_block':
      return typeof cfg.prompt === 'string' && cfg.prompt.trim()
        ? cfg.prompt.trim().slice(0, 40)
        : null;
    case 'end':
      return null;
    case 'wait': {
      if (cfg.modo === 'fecha') {
        return typeof cfg.fecha_objetivo === 'string' && cfg.fecha_objetivo
          ? `Fecha: ${cfg.fecha_objetivo.slice(0, 16).replace('T', ' ')}`
          : 'Fecha sin definir';
      }
      if (cfg.modo === 'horario') {
        const h = (cfg.horario ?? {}) as { desde?: string; hasta?: string };
        return h.desde && h.hasta ? `Horario: ${h.desde}–${h.hasta}` : 'Horario sin definir';
      }
      return null;
    }
    case 'department': {
      const name = typeof cfg.department_name === 'string' ? cfg.department_name : '';
      const id = typeof cfg.department_id === 'string' ? cfg.department_id : '';
      return name || (id ? `Depto. ${id.slice(0, 8)}` : null);
    }
    case 'http_request': {
      const method = typeof cfg.method === 'string' ? cfg.method : 'GET';
      const url = typeof cfg.url === 'string' ? cfg.url : '';
      try {
        const host = url ? new URL(url).host : '';
        return host ? `${method} ${truncate(host, 36)}` : `${method} sin URL`;
      } catch {
        return `${method} ${truncate(url, 36)}`;
      }
    }
    case 'payment_gateway': {
      const provider = typeof cfg.provider === 'string' ? cfg.provider : 'stripe';
      const amount =
        cfg.amount_mode === 'variable'
          ? `{{${String(cfg.amount_var ?? 'monto')}}}`
          : `${Number(cfg.amount) || 0}`;
      return `${provider} · ${amount} ${String(cfg.currency ?? 'MXN')}`;
    }
    case 'ai_media': {
      if (cfg.kind === 'image') {
        const img = (cfg.image ?? {}) as { provider?: string; prompt?: string };
        return `${img.provider ?? 'pollinations'} · ${truncate(String(img.prompt ?? ''), 34)}`;
      }
      const audio = (cfg.audio ?? {}) as { provider?: string; voice?: string };
      return `${audio.provider ?? 'edge'} · ${audio.voice ?? 'es-MX-DaliaNeural'}`;
    }
    case 'official_call':
      return cfg.mode === 'call' ? 'Llamada oficial' : 'Permiso de llamada';
    default:
      return null;
    case 'send_message': {
      const items = Array.isArray(cfg.items) ? (cfg.items as Array<Record<string, unknown>>) : [];
      if (items.length > 0) return resumenBurbujas(items, t);
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      return text.length > 0 ? truncate(text) : null;
    }
    case 'send_buttons': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<Record<string, unknown>>)
        : [];
      const titles = buttons
        .map((b) => (typeof b.title === 'string' ? b.title : ''))
        .filter(Boolean)
        .join(' / ');
      if (text.length > 0) {
        return titles
          ? `${truncate(text, 40)} · ${truncate(titles, 35)}`
          : truncate(text);
      }
      return titles || null;
    }
    case 'send_list': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const sections = Array.isArray(cfg.sections)
        ? (cfg.sections as Array<Record<string, unknown>>)
        : [];
      const rowCount = sections.reduce<number>((sum, s) => {
        const rows = Array.isArray(s.rows) ? s.rows : [];
        return sum + rows.length;
      }, 0);
      if (text.length > 0) {
        return rowCount > 0
          ? `${truncate(text, 50)} · ${t ? t('options', { count: rowCount }) : `${rowCount} option${rowCount === 1 ? '' : 's'}`}`
          : truncate(text);
      }
      return rowCount > 0
        ? t
          ? t('optionsAcrossSections', { rowCount, sectionCount: sections.length })
          : `${rowCount} option${rowCount === 1 ? '' : 's'} across ${sections.length} section${sections.length === 1 ? '' : 's'}`
        : null;
    }
    case 'send_media': {
      const mediaType =
        typeof cfg.media_type === 'string' ? cfg.media_type : '';
      const filename = typeof cfg.filename === 'string' ? cfg.filename : '';
      const url = typeof cfg.media_url === 'string' ? cfg.media_url : '';
      const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
      const label = mediaType
        ? t ? t(mediaType) || (mediaType.charAt(0).toUpperCase() + mediaType.slice(1)) : mediaType.charAt(0).toUpperCase() + mediaType.slice(1)
        : t ? t('media') : 'Media';
      if (!url) return t ? t('noFile', { label }) : `${label} (no file uploaded)`;
      const name = filename || url.split('/').pop() || 'file';
      return caption
        ? `${label}: ${truncate(name, 30)} · ${truncate(caption, 40)}`
        : `${label}: ${truncate(name, 60)}`;
    }
    case 'collect_input': {
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      if (prompt.length > 0) {
        return varKey
          ? `${truncate(prompt, 50)} → vars.${varKey}`
          : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case 'wait': {
      const segundos = typeof cfg.segundos === 'number' ? cfg.segundos : 0;
      if (!(segundos > 0)) return null;
      if (segundos >= 3600) {
        const h = Math.floor(segundos / 3600);
        const m = Math.round((segundos % 3600) / 60);
        return m > 0 ? `${h} h ${m} min` : `${h} h`;
      }
      if (segundos >= 60 && segundos % 60 === 0) {
        return t ? t('minutes', { count: segundos / 60 }) : `${segundos / 60} min`;
      }
      return t ? t('seconds', { count: segundos }) : `${segundos} s`;
    }
    case 'send_payment': {
      const monto = typeof cfg.monto === 'number' && cfg.monto > 0 ? cfg.monto : 0;
      const clabe = typeof cfg.clabe === 'string' ? cfg.clabe.replace(/\s+/g, '') : '';
      const partes = [
        monto ? `$${monto} MXN` : null,
        clabe ? `CLABE …${clabe.slice(-4)}` : null,
        cfg.con_boton ? 'con botón' : 'solo texto',
      ].filter(Boolean);
      return partes.join(' · ');
    }
    case 'send_template': {
      const nombre = typeof cfg.template_name === 'string' ? cfg.template_name : '';
      const idioma = typeof cfg.language === 'string' ? cfg.language : '';
      return nombre ? `${nombre}${idioma ? ` (${idioma})` : ''}` : null;
    }
    case 'move_kanban': {
      const etapa = typeof cfg.stage_name === 'string' ? cfg.stage_name : '';
      return etapa ? `→ ${etapa}` : null;
    }
    case 'meta_capi': {
      const ev = typeof cfg.event_name === 'string' ? cfg.event_name : '';
      const valor = typeof cfg.value === 'number' && cfg.value > 0 ? cfg.value : 0;
      const moneda = typeof cfg.currency === 'string' && cfg.currency ? cfg.currency : 'MXN';
      return ev ? (valor ? `${ev} · $${valor} ${moneda}` : ev) : null;
    }
    case 'save_reply': {
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const indefinido = cfg.esperar_indefinido === true;
      const segundos =
        typeof cfg.espera_segundos === 'number'
          ? cfg.espera_segundos
          : typeof cfg.espera_minutos === 'number'
            ? cfg.espera_minutos * 60
            : 0;
      const buffer = typeof cfg.buffer_segundos === 'number' ? cfg.buffer_segundos : 0;
      const partes = [
        prompt ? truncate(prompt, 34) : null,
        varKey ? `→ vars.${varKey}` : null,
        indefinido
          ? t
            ? t('waitIndefinite')
            : 'indefinido'
          : segundos > 0
            ? formatearEspera(segundos, t)
            : null,
        buffer > 0
          ? t
            ? t('bufferSeconds', { count: buffer })
            : `buffer ${buffer} s`
          : null,
      ].filter(Boolean);
      return partes.length ? partes.join(' · ') : null;
    }
    case 'condition': {
      const subjectKey =
        typeof cfg.subject_key === 'string' ? cfg.subject_key : '';
      if (!subjectKey) return null;
      const subject =
        cfg.subject === 'tag'
          ? 'tag'
          : cfg.subject === 'contact_field'
            ? 'field'
            : 'var';
      const subjectStr =
        subject === 'tag'
          ? t ? t('hasTag', { tag: truncate(subjectKey, 24) }) : `has tag ${truncate(subjectKey, 24)}`
          : `${subject}.${subjectKey}`;
      const op =
        cfg.operator === 'equals'
          ? '=='
          : cfg.operator === 'contains'
            ? t ? t('opContains') : 'contains'
            : cfg.operator === 'present'
              ? t ? t('opExists') : 'exists'
              : cfg.operator === 'absent'
                ? t ? t('opMissing') : 'missing'
                : '';
      const value = typeof cfg.value === 'string' ? cfg.value : '';
      const valStr =
        (cfg.operator === 'equals' || cfg.operator === 'contains') && value
          ? ` "${truncate(value, 20)}"`
          : '';
      return subject === 'tag' ? subjectStr : `${subjectStr} ${op}${valStr}`;
    }
    case 'set_tag': {
      const mode = cfg.mode === 'remove' ? (t ? t('modeRemove') : 'Remove') : (t ? t('modeAdd') : 'Add');
      const tagId = typeof cfg.tag_id === 'string' ? cfg.tag_id : '';
      // No tag name available without an async lookup here; show a
      // short prefix of the UUID so users can disambiguate between
      // multiple set_tag nodes at a glance.
      return tagId
        ? t ? t('tagPicked', { mode, tag: tagId.slice(0, 8) }) : `${mode} tag ${tagId.slice(0, 8)}…`
        : t ? t('tagNone', { mode }) : `${mode} tag (none picked)`;
    }
    case 'handoff': {
      const note = typeof cfg.note === 'string' ? cfg.note : '';
      return note.length > 0 ? truncate(note) : null;
    }
  }
}

// ============================================================
// Catálogo visual de bloques (panel flotante del lienzo).
//
// Rediseño del 22-nov-2026. Cada bloque del catálogo apunta a un tipo de
// nodo que el motor YA sabe ejecutar (`tipo`), o queda como «Próximamente»
// (sin `tipo`): se ve en el catálogo pero no se puede agregar, para no
// prometer algo que el motor todavía no hace.
// ============================================================

export type BloqueId =
  | 'inicio'
  | 'mensaje'
  | 'template'
  | 'etiquetas'
  | 'pago'
  | 'menu'
  | 'menu_lista'
  | 'esperar_respuesta'
  | 'capturar'
  | 'controlador'
  | 'condicional'
  | 'distribuidor'
  | 'conexion'
  | 'pixel'
  | 'intervalo'
  | 'departamento'
  | 'integracion'
  | 'bloque_ia'
  | 'agente_ia'
  | 'kanban'
  | 'manipulador'
  | 'notificacion'
  | 'venta_aprobada'
  | 'carrusel'
  | 'pasarela'
  | 'multimedia_ia'
  | 'llamada';

export interface Bloque {
  id: BloqueId;
  icon: typeof Workflow;
  /** Tipo de nodo que crea. Sin él, el bloque está «Próximamente». */
  tipo?: NodeType;
  /** Tono del ícono cuando el bloque todavía no existe en el motor. */
  tono: 'violeta' | 'azul';
}

export const CATALOGO_BLOQUES: Bloque[] = [
  { id: 'mensaje', icon: MessageSquare, tipo: 'send_message', tono: 'violeta' },
  { id: 'template', icon: FileText, tipo: 'send_template', tono: 'violeta' },
  { id: 'etiquetas', icon: Tag, tipo: 'set_tag', tono: 'violeta' },
  { id: 'pago', icon: CreditCard, tipo: 'send_payment', tono: 'violeta' },
  { id: 'menu', icon: List, tipo: 'send_buttons', tono: 'violeta' },
  { id: 'menu_lista', icon: List, tipo: 'send_list', tono: 'violeta' },
  { id: 'carrusel', icon: LayoutGrid, tipo: 'carousel', tono: 'azul' },
  { id: 'esperar_respuesta', icon: Save, tipo: 'save_reply', tono: 'violeta' },
  { id: 'controlador', icon: MessageCircle, tipo: 'handoff', tono: 'azul' },
  { id: 'notificacion', icon: Bell, tipo: 'notification', tono: 'azul' },
  { id: 'condicional', icon: GitBranch, tipo: 'condition', tono: 'violeta' },
  { id: 'distribuidor', icon: GitBranch, tipo: 'distributor', tono: 'violeta' },
  { id: 'conexion', icon: Share2, tipo: 'connect_flow', tono: 'violeta' },
  { id: 'pixel', icon: Target, tipo: 'meta_capi', tono: 'azul' },
  { id: 'intervalo', icon: Clock, tipo: 'wait', tono: 'violeta' },
  { id: 'departamento', icon: Building2, tipo: 'department', tono: 'azul' },
  { id: 'integracion', icon: Globe, tipo: 'http_request', tono: 'azul' },
  { id: 'bloque_ia', icon: Bot, tipo: 'ai_block', tono: 'azul' },
  { id: 'agente_ia', icon: Bot, tipo: 'end', tono: 'azul' },
  { id: 'kanban', icon: Kanban, tipo: 'move_kanban', tono: 'azul' },
  { id: 'manipulador', icon: SlidersHorizontal, tipo: 'manipulator', tono: 'violeta' },
  { id: 'venta_aprobada', icon: DollarSign, tipo: 'sale_approved', tono: 'violeta' },
  { id: 'pasarela', icon: CreditCard, tipo: 'payment_gateway', tono: 'azul' },
  { id: 'llamada', icon: PhoneCall, tipo: 'official_call', tono: 'azul' },
  { id: 'multimedia_ia', icon: Sparkles, tipo: 'ai_media', tono: 'violeta' },
];

/** Atajos de multimedia dentro del bloque «Mensaje» (nodo send_media). */
export const ATAJOS_MEDIA: {
  medio: 'image' | 'video' | 'document' | 'audio';
  icon: typeof Workflow;
  clave: string;
}[] = [
  { medio: 'image', icon: ImageIcon, clave: 'paletteImage' },
  { medio: 'video', icon: Video, clave: 'paletteVideo' },
  { medio: 'document', icon: FileText, clave: 'paletteDocument' },
  { medio: 'audio', icon: Mic, clave: 'paletteAudio' },
];

/** Ícono de cada tipo de burbuja del Mensaje compuesto (tarjeta y panel). */
export const EMOJI_BURBUJA: Record<string, string> = {
  text: '💬',
  image: '🖼',
  video: '🎬',
  audio: '🎤',
  document: '📄',
  sticker: '🏷',
  interval: '⏱',
};

/**
 * Resumen del Mensaje compuesto en la tarjeta del lienzo:
 * «💬 Texto · 🖼 Imagen · ⏱ 10 s — Hola, ¿cómo estás?».
 */
export function resumenBurbujas(
  items: Array<Record<string, unknown>>,
  t?: (key: string, values?: Record<string, string | number>) => string,
): string {
  const partes = items.map((b) => {
    const tipo = String(b.tipo ?? 'text');
    const emoji = EMOJI_BURBUJA[tipo] ?? '•';
    if (tipo === 'interval') return `${emoji} ${Number(b.segundos) || 0} s`;
    return `${emoji} ${t ? t(`bubble_${tipo}`) : tipo}`;
  });
  const primerTexto = items.find((b) => b.tipo === 'text' && typeof b.text === 'string' && b.text.trim());
  const cabeza = partes.join(' · ');
  return primerTexto ? `${cabeza} — ${truncate(String(primerTexto.text), 60)}` : cabeza;
}

/**
 * Atajo de multimedia de la paleta: un Mensaje que ya trae la burbuja
 * de ese tipo (en lugar del nodo suelto send_media de antes).
 */
export function configAtajoMedio(medio: string): Record<string, unknown> {
  return {
    items: [{ tipo: medio, media_url: '', text: '', segundos: 3, like: false }],
  };
}

/** Tipo MIME del arrastre de un bloque desde el panel hasta el lienzo. */
export const DND_BLOQUE = 'application/x-wacrm-bloque';

// ============================================================
// Color de cada arista según su salida (rediseño del 22-nov-2026):
//   verde → éxito / respondió / se cumple la condición
//   rojo  → la condición no se cumple
//   ámbar → no contestó a tiempo (timeout)
//   resto → el color de la categoría del nodo de origen
// ============================================================

export const COLOR_EXITO = '#22c55e';
export const COLOR_NEGATIVO = '#ef4444';
export const COLOR_TIMEOUT = '#f5a524';

export function colorDeSalida(tipoOrigen: NodeType, salida: string | null | undefined): string {
  if (tipoOrigen === 'condition') {
    if (salida === 'true') return COLOR_EXITO;
    if (salida === 'false') return COLOR_NEGATIVO;
  }
  if (tipoOrigen === 'send_payment') {
    if (salida === 'aprobado') return COLOR_EXITO;
    if (salida === 'rechazado') return COLOR_NEGATIVO;
  }
  if (tipoOrigen === 'save_reply') {
    if (salida === 'contesto') return COLOR_EXITO;
    if (salida === 'no_contesto') return COLOR_TIMEOUT;
  }
  if (tipoOrigen === 'payment_gateway') {
    if (salida === 'approved') return COLOR_EXITO;
    if (salida === 'rejected') return COLOR_NEGATIVO;
    if (salida === 'timeout') return COLOR_TIMEOUT;
  }
  if (tipoOrigen === 'official_call') {
    if (salida === 'granted') return COLOR_EXITO;
    if (salida === 'denied') return COLOR_NEGATIVO;
    if (salida === 'timeout') return COLOR_TIMEOUT;
  }
  if (tipoOrigen === 'http_request' && salida === 'error') return COLOR_NEGATIVO;
  if (tipoOrigen === 'wait' && salida === 'fuera_ventana') return COLOR_TIMEOUT;
  return nodeColors(tipoOrigen).solid;
}
