import {
  AtSign,
  Bot,
  Building2,
  Clock,
  Coins,
  Database,
  FileText,
  Headphones,
  Inbox,
  KeyRound,
  Languages,
  LayoutGrid,
  MessageCircle,
  Package,
  Palette,
  Phone,
  Plug,
  PlugZap,
  Radar,
  Send,
  Shield,
  Sparkles,
  Tags,
  User,
  UserPlus,
  Users,
  Wallet,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Configuración, con el mismo menú que Leona (medido el 27-nov-2026):
 *
 *   CUENTA          Empresa · Equipo · Invitaciones a la plataforma ·
 *                   Acceso de soporte · Traducciones de flujo · Uso de IA
 *   AUTOMATIZACIÓN  Flujos estándar · Envíos masivos · Respuestas rápidas ·
 *                   Templates de WhatsApp · Variables globales ·
 *                   Campos personalizados · Etiquetas
 *   INTEGRACIONES   Integraciones · Seguimiento · Productos · Herramientas MCP
 *
 * Las secciones propias del WaCRM que Leona no pone en este menú siguen
 * existiendo (`?tab=` las abre y los enlaces viejos funcionan) y viven
 * dentro de su sección madre: Departamentos, Horarios, Moneda e Inbox en
 * «Empresa»; Pagos, Multimedia IA, Llamadas, Credenciales HTTP, Webhooks
 * y API keys en «Integraciones»; perfil, seguridad y apariencia en el
 * menú de usuario; las conexiones de WhatsApp en «Conexiones».
 */
export const SETTINGS_SECTIONS = [
  // CUENTA
  'empresa',
  'members',
  'invitaciones',
  'soporte',
  'traducciones',
  'uso-ia',
  // AUTOMATIZACIÓN
  'flujos-estandar',
  'envios',
  'quick-replies',
  'templates',
  'variables',
  'fields',
  'tags',
  // INTEGRACIONES
  'integrations',
  'tracking',
  'productos',
  'mcp',
  // Dentro de otra sección (no salen en el menú)
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'inbox',
  'deals',
  'departments',
  'business-hours',
  'api',
  'payments',
  'ai-media',
  'calling',
  'http-credentials',
  'webhooks',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'empresa';

export type GrupoAjustes = 'cuenta' | 'automatizacion' | 'integraciones' | 'oculta';

export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: GrupoAjustes;
  /** Sección del menú que se marca cuando esta está abierta. */
  parent?: SettingsSection;
  /** Lleva a otra página en vez de abrir un panel (como en Leona). */
  href?: string;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  empresa: { id: 'empresa', label: 'Empresa', icon: Building2, group: 'cuenta' },
  members: { id: 'members', label: 'Equipo', icon: Users, group: 'cuenta' },
  invitaciones: { id: 'invitaciones', label: 'Invitaciones a la plataforma', icon: UserPlus, group: 'cuenta' },
  soporte: { id: 'soporte', label: 'Acceso de soporte', icon: Headphones, group: 'cuenta' },
  traducciones: { id: 'traducciones', label: 'Traducciones de flujo', icon: Languages, group: 'cuenta' },
  'uso-ia': { id: 'uso-ia', label: 'Uso de IA', icon: Sparkles, group: 'cuenta' },

  'flujos-estandar': { id: 'flujos-estandar', label: 'Flujos estándar', icon: Zap, group: 'automatizacion' },
  envios: { id: 'envios', label: 'Envíos masivos', icon: Send, group: 'automatizacion', href: '/broadcasts' },
  'quick-replies': { id: 'quick-replies', label: 'Respuestas rápidas', icon: MessageCircle, group: 'automatizacion' },
  templates: { id: 'templates', label: 'Templates de WhatsApp', icon: FileText, group: 'automatizacion' },
  variables: { id: 'variables', label: 'Variables globales', icon: AtSign, group: 'automatizacion' },
  fields: { id: 'fields', label: 'Campos personalizados', icon: Database, group: 'automatizacion' },
  tags: { id: 'tags', label: 'Etiquetas', icon: Tags, group: 'automatizacion' },

  integrations: { id: 'integrations', label: 'Integraciones', icon: Plug, group: 'integraciones' },
  tracking: { id: 'tracking', label: 'Seguimiento', icon: Radar, group: 'integraciones' },
  productos: { id: 'productos', label: 'Productos', icon: Package, group: 'integraciones' },
  mcp: { id: 'mcp', label: 'Herramientas MCP', icon: Bot, group: 'integraciones' },

  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'oculta', parent: 'empresa' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'oculta', parent: 'members' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'oculta', parent: 'members' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'oculta', parent: 'empresa' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'oculta', parent: 'integrations' },
  inbox: { id: 'inbox', label: 'Inbox', icon: Inbox, group: 'oculta', parent: 'empresa' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'oculta', parent: 'empresa' },
  departments: { id: 'departments', label: 'Departments', icon: Building2, group: 'oculta', parent: 'empresa' },
  'business-hours': { id: 'business-hours', label: 'Business hours', icon: Clock, group: 'oculta', parent: 'empresa' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'oculta', parent: 'integrations' },
  payments: { id: 'payments', label: 'Payments', icon: Wallet, group: 'oculta', parent: 'integrations' },
  'ai-media': { id: 'ai-media', label: 'AI media', icon: Sparkles, group: 'oculta', parent: 'integrations' },
  calling: { id: 'calling', label: 'Official calls', icon: Phone, group: 'oculta', parent: 'integrations' },
  'http-credentials': { id: 'http-credentials', label: 'HTTP credentials', icon: KeyRound, group: 'oculta', parent: 'integrations' },
  webhooks: { id: 'webhooks', label: 'Webhooks', icon: Webhook, group: 'oculta', parent: 'integrations' },
};

export const RAIL_GROUPS: { label: string | null; group: GrupoAjustes }[] = [
  { label: 'Cuenta', group: 'cuenta' },
  { label: 'Automatización', group: 'automatizacion' },
  { label: 'Integraciones', group: 'integraciones' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** Sección del menú que se marca para una sección (la madre si está dentro de otra). */
export function seccionDelMenu(section: SettingsSection): SettingsSection {
  return SECTION_META[section].parent ?? section;
}

/**
 * `?tab=` → sección. Alias viejos: «custom-fields» → Campos
 * personalizados. Lo desconocido abre «Empresa», como Leona.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'custom-fields') return 'fields';
  if (raw === 'accounts') return 'empresa';
  if (raw === 'team') return 'members';
  if (raw === 'mcp_credentials') return 'mcp';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
