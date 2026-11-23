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
  Bot,
  Building2,
  CreditCard,
  FileBadge,
  FileText,
  GitFork,
  Headset,
  Image as ImageIcon,
  Inbox,
  KanbanSquare,
  Link2,
  ListChecks,
  ListPlus,
  MessageCircle,
  MessageSquareReply,
  Mic,
  Paperclip,
  PlayCircle,
  Plug,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Target,
  Timer,
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
    icon: PlayCircle,
    color: 'text-emerald-400',
    category: 'flow',
  },
  send_message: {
    slugSeed: 'Send message',
    icon: MessageCircle,
    color: 'text-sky-400',
    category: 'messaging',
  },
  send_buttons: {
    slugSeed: 'Send buttons',
    icon: ListChecks,
    color: 'text-primary',
    category: 'messaging',
  },
  send_list: {
    slugSeed: 'Send list',
    icon: ListPlus,
    color: 'text-indigo-400',
    category: 'messaging',
  },
  send_media: {
    slugSeed: 'Send media',
    icon: Paperclip,
    color: 'text-cyan-400',
    category: 'messaging',
  },
  collect_input: {
    slugSeed: 'Collect input',
    icon: Inbox,
    color: 'text-teal-400',
    category: 'logic',
  },
  condition: {
    slugSeed: 'If / else',
    icon: GitFork,
    color: 'text-fuchsia-400',
    category: 'logic',
  },
  wait: {
    slugSeed: 'Wait',
    icon: Timer,
    color: 'text-orange-400',
    category: 'flow',
  },
  save_reply: {
    slugSeed: 'Save reply',
    icon: MessageSquareReply,
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
    icon: FileBadge,
    color: 'text-violet-400',
    category: 'messaging',
  },
  move_kanban: {
    slugSeed: 'Kanban',
    icon: KanbanSquare,
    color: 'text-sky-400',
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
    icon: Headset,
    color: 'text-amber-400',
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
const NODE_HUE: Record<NodeType, { l: number; c: number; h: number }> = {
  start: { l: 0.66, c: 0.15, h: 155 }, // verde — el disparador
  send_message: { l: 0.56, c: 0.24, h: 285 }, // morado #6C47FF
  send_media: { l: 0.6, c: 0.21, h: 290 }, // morado
  send_buttons: { l: 0.6, c: 0.2, h: 300 }, // morado rosado — menú
  send_list: { l: 0.6, c: 0.2, h: 300 }, // morado rosado — menú
  set_tag: { l: 0.64, c: 0.17, h: 320 }, // magenta — etiquetas
  wait: { l: 0.76, c: 0.16, h: 70 }, // ámbar — intervalo inteligente
  save_reply: { l: 0.76, c: 0.16, h: 70 }, // ámbar — esperar respuesta
  collect_input: { l: 0.74, c: 0.15, h: 60 }, // ámbar
  condition: { l: 0.74, c: 0.16, h: 55 }, // ámbar anaranjado — condicional
  meta_capi: { l: 0.72, c: 0.13, h: 180 }, // turquesa — conversiones
  send_payment: { l: 0.7, c: 0.15, h: 165 }, // verde turquesa — cobro (conversión)
  send_template: { l: 0.58, c: 0.22, h: 280 }, // morado — mensaje
  move_kanban: { l: 0.66, c: 0.15, h: 240 }, // azul — CRM
  handoff: { l: 0.66, c: 0.15, h: 230 }, // azul cielo — controlador de chat
  end: { l: 0.62, c: 0.18, h: 258 }, // azul — pasa al Agente de IA
};

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
  const t = NODE_HUE[type];
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    soft: `oklch(${t.l} ${t.c} ${t.h} / 0.14)`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
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
    case 'end':
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
  | 'manipulador';

export interface Bloque {
  id: BloqueId;
  icon: typeof Workflow;
  /** Tipo de nodo que crea. Sin él, el bloque está «Próximamente». */
  tipo?: NodeType;
  /** Tono del ícono cuando el bloque todavía no existe en el motor. */
  tono: 'violeta' | 'azul';
}

export const CATALOGO_BLOQUES: Bloque[] = [
  { id: 'inicio', icon: PlayCircle, tipo: 'start', tono: 'azul' },
  { id: 'mensaje', icon: MessageCircle, tipo: 'send_message', tono: 'violeta' },
  { id: 'template', icon: FileBadge, tipo: 'send_template', tono: 'violeta' },
  { id: 'etiquetas', icon: Tag, tipo: 'set_tag', tono: 'violeta' },
  { id: 'pago', icon: CreditCard, tipo: 'send_payment', tono: 'violeta' },
  { id: 'menu', icon: ListPlus, tipo: 'send_buttons', tono: 'violeta' },
  { id: 'menu_lista', icon: ListChecks, tipo: 'send_list', tono: 'violeta' },
  { id: 'esperar_respuesta', icon: MessageSquareReply, tipo: 'save_reply', tono: 'violeta' },
  { id: 'capturar', icon: Inbox, tipo: 'collect_input', tono: 'violeta' },
  { id: 'controlador', icon: Headset, tipo: 'handoff', tono: 'azul' },
  { id: 'condicional', icon: GitFork, tipo: 'condition', tono: 'violeta' },
  { id: 'distribuidor', icon: Shuffle, tono: 'violeta' },
  { id: 'conexion', icon: Link2, tono: 'violeta' },
  { id: 'pixel', icon: Target, tipo: 'meta_capi', tono: 'azul' },
  { id: 'intervalo', icon: Timer, tipo: 'wait', tono: 'violeta' },
  { id: 'departamento', icon: Building2, tono: 'azul' },
  { id: 'integracion', icon: Plug, tono: 'azul' },
  { id: 'bloque_ia', icon: Sparkles, tono: 'azul' },
  { id: 'agente_ia', icon: Bot, tipo: 'end', tono: 'azul' },
  { id: 'kanban', icon: KanbanSquare, tipo: 'move_kanban', tono: 'azul' },
  { id: 'manipulador', icon: SlidersHorizontal, tono: 'violeta' },
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
  return nodeColors(tipoOrigen).solid;
}
