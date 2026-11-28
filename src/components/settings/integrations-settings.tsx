'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  BarChart3,
  Eye,
  EyeOff,
  Loader2,
  QrCode,
  RefreshCw,
  Search,
  Waypoints,
  PlugZap,
  Wallet,
  Sparkles,
  Phone,
  KeyRound,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Proveedor = 'dapi' | 'lowtrack' | 'openrouter' | 'leona';
type Categoria = 'whatsapp' | 'seguimiento' | 'ia' | 'flujos';

interface Integracion {
  provider: Proveedor;
  name: string | null;
  updated_at: string;
}

interface Tarjeta {
  id: Proveedor;
  titulo: string;
  categoria: Categoria;
  etiqueta: string;
  descripcion: string;
  icono: LucideIcon;
  novedad?: boolean;
  modal: {
    titulo: string;
    descripcion: string;
    /** Sin nombre = modal de un solo campo (D-API). */
    nombre?: { label: string; placeholder: string };
    clave: { label: string; placeholder: string };
    ayuda?: { texto: string; enlace: string; label: string };
  };
  /** Acción que sigue después de conectar. */
  siguiente?: { href: string; label: string };
}

/** Las tarjetas copian textos y campos de Leona → Integraciones. */
const TARJETAS: Tarjeta[] = [
  {
    id: 'dapi',
    titulo: 'D-API',
    categoria: 'whatsapp',
    etiqueta: 'WHATSAPP',
    descripcion: 'API Key secreta para conectar la API Web de D-API. No uses la clave pk_live_.',
    icono: QrCode,
    novedad: true,
    modal: {
      titulo: 'Clave de D-API',
      descripcion:
        'En el panel de D-API, genera la API Key secreta y pégala aquí. La clave pk_live_ no conecta la API Web.',
      clave: { label: 'API Key secreta', placeholder: 'Pega la API Key' },
    },
    siguiente: { href: '/settings?tab=whatsapp', label: 'Conectar número por QR →' },
  },
  {
    id: 'lowtrack',
    titulo: 'LowTrack',
    categoria: 'seguimiento',
    etiqueta: 'SEGUIMIENTO',
    descripcion: 'Seguimiento de ventas y envío automático al Facebook CAPI',
    icono: BarChart3,
    modal: {
      titulo: 'Nueva integración: LowTrack',
      descripcion: 'Genérelo en Integraciones → API Tokens en el panel LowTrack.',
      nombre: { label: 'Nombre de la empresa', placeholder: 'Ej.: Mi Tienda S.L.' },
      clave: { label: 'Token de API', placeholder: 'Pega aquí el token generado en LowTrack…' },
      ayuda: {
        texto: 'Genérelo en Integraciones → API Tokens en el panel LowTrack.',
        enlace: 'https://lowtrack.com.br/docs/webhook',
        label: 'Cómo obtener el token',
      },
    },
  },
  {
    id: 'openrouter',
    titulo: 'OpenRouter',
    categoria: 'ia',
    etiqueta: 'INTELIGENCIA ARTIFICIAL',
    descripcion: 'Una clave para varios modelos (Claude, GPT, Gemini, Llama y otros)',
    icono: Waypoints,
    modal: {
      titulo: 'Proveedor: OpenRouter',
      descripcion: 'Una clave para varios modelos (Claude, GPT, Gemini, Llama y otros).',
      nombre: { label: 'Nombre de la clave', placeholder: 'Ej.: Producción, Flujo de ventas' },
      clave: { label: 'Clave de API', placeholder: 'Pega aquí la clave generada en el proveedor…' },
      ayuda: {
        texto: 'Genera en openrouter.ai → Keys.',
        enlace: 'https://openrouter.ai/keys',
        label: 'Cómo obtener la clave',
      },
    },
    siguiente: { href: '/agents', label: 'Usar en el agente de IA →' },
  },
  {
    id: 'leona',
    titulo: 'Leona',
    categoria: 'flujos',
    etiqueta: 'FLUJOS',
    descripcion: 'Importa tus flujos de Leona completos, con sus bloques y conexiones',
    icono: Workflow,
    modal: {
      titulo: 'Conectar Leona',
      descripcion:
        'En Leona: Configuración → Herramientas MCP → Nueva credencial (token estático). Pega aquí el token.',
      nombre: { label: 'Nombre de la credencial', placeholder: 'Ej.: Leona principal' },
      clave: { label: 'Token de Leona (MCP)', placeholder: 'Pega aquí el token estático de Leona…' },
      ayuda: {
        texto: 'Solo se usa para leer tus flujos y traerlos aquí.',
        enlace: 'https://app.leonasolutions.io/settings?tab=mcp_credentials',
        label: 'Abrir Herramientas MCP',
      },
    },
    siguiente: { href: '/flows', label: 'Importar flujos →' },
  },
];

const MAS: { tab: string; titulo: string; texto: string; icono: LucideIcon }[] = [
  { tab: 'whatsapp', titulo: 'WhatsApp (conexiones)', texto: 'Números de Meta Cloud API y por QR', icono: PlugZap },
  { tab: 'payments', titulo: 'Pagos', texto: 'Hotmart, Whop, Mercado Pago, Stripe y SPEI', icono: Wallet },
  { tab: 'ai-media', titulo: 'Multimedia IA', texto: 'Voz e imágenes generadas en los flujos', icono: Sparkles },
  { tab: 'calling', titulo: 'Llamadas oficiales', texto: 'WhatsApp Business Calling', icono: Phone },
  { tab: 'http-credentials', titulo: 'Credenciales HTTP', texto: 'Claves para el bloque Integración', icono: KeyRound },
  { tab: 'webhooks', titulo: 'Webhooks', texto: 'Avisos salientes a otros sistemas', icono: Webhook },
  { tab: 'api', titulo: 'API keys', texto: 'Acceso a la API del WaCRM', icono: KeyRound },
];

const CATEGORIAS: { id: 'todas' | Categoria; label: string }[] = [
  { id: 'todas', label: 'Todas' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'ia', label: 'Inteligencia artificial' },
  { id: 'flujos', label: 'Flujos' },
];

const ERRORES: Record<string, string> = {
  dapi_public_key: 'La clave pk_live_ no conecta la API Web. Usa la API Key secreta.',
  invalid_api_key: 'Pega una clave válida.',
};

/**
 * Configuración → Integraciones, igual que en Leona: D-API (WhatsApp por
 * QR), LowTrack (ventas → CAPI) y OpenRouter (IA). Las claves se guardan
 * cifradas y nunca vuelven al navegador.
 */
export function IntegrationsSettings() {
  const [cargando, setCargando] = useState(true);
  const [activas, setActivas] = useState<Integracion[]>([]);
  const [categoria, setCategoria] = useState<'todas' | Categoria>('todas');
  const [busqueda, setBusqueda] = useState('');
  const [abierta, setAbierta] = useState<Tarjeta | null>(null);
  const [nombre, setNombre] = useState('');
  const [clave, setClave] = useState('');
  const [ver, setVer] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [borrar, setBorrar] = useState<Proveedor | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/settings/integrations');
      const json = (await res.json().catch(() => ({}))) as { integrations?: Integracion[] };
      if (res.ok) setActivas(json.integrations ?? []);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const activa = (id: Proveedor) => activas.find((a) => a.provider === id) ?? null;

  const disponibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return TARJETAS.filter((t) => !activas.some((a) => a.provider === t.id))
      .filter((t) => categoria === 'todas' || t.categoria === categoria)
      .filter((t) => !q || `${t.titulo} ${t.descripcion}`.toLowerCase().includes(q));
  }, [activas, categoria, busqueda]);

  const abrir = (t: Tarjeta) => {
    setAbierta(t);
    setNombre(activa(t.id)?.name ?? '');
    setClave('');
    setVer(false);
  };

  const editando = abierta ? Boolean(activa(abierta.id)) : false;

  const guardar = async () => {
    if (!abierta) return;
    const k = clave.trim();
    if (!k && !editando) {
      toast.error(ERRORES.invalid_api_key);
      return;
    }
    if (abierta.id === 'dapi' && k.startsWith('pk_live_')) {
      toast.error(ERRORES.dapi_public_key);
      return;
    }
    setGuardando(true);
    try {
      const res = await fetch('/api/settings/integrations', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: abierta.id, name: nombre.trim(), secret: k }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(ERRORES[json.error ?? ''] ?? 'No se pudo guardar.');
        return;
      }
      toast.success(`${abierta.titulo} conectado.`);
      setAbierta(null);
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (id: Proveedor) => {
    const res = await fetch(`/api/settings/integrations?provider=${id}`, { method: 'DELETE' });
    setBorrar(null);
    if (!res.ok) {
      toast.error('No se pudo eliminar.');
      return;
    }
    toast.success('Integración eliminada.');
    await cargar();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Integraciones</h1>
          <p className="text-muted-foreground text-sm">
            Conecta seguimiento de ventas, IA y WhatsApp a tu cuenta.
          </p>
        </div>
        <Button size="icon" variant="ghost" onClick={() => void cargar()} aria-label="Recargar">
          <RefreshCw className={cn('size-4', cargando && 'animate-spin')} />
        </Button>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar integración…"
            className="bg-muted h-8 pl-8 text-xs"
          />
        </div>
        <div className="bg-muted flex flex-wrap rounded-lg p-0.5">
          {CATEGORIAS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategoria(c.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium',
                categoria === c.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {activas.length > 0 && (
        <section className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.09em] uppercase">
            Activas {activas.length}
          </p>
          <div className="space-y-2">
            {TARJETAS.filter((t) => activa(t.id)).map((t) => {
              const Icono = t.icono;
              const fila = activa(t.id)!;
              return (
                <div
                  key={t.id}
                  className="border-primary/40 bg-card flex flex-wrap items-center gap-3 rounded-xl border p-3"
                >
                  <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                    <Icono className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{fila.name || t.titulo}</p>
                    <p className="text-muted-foreground text-xs">{t.titulo}</p>
                  </div>
                  <Badge variant="outline" className="border-emerald-400/40 text-emerald-400">
                    ● Activo
                  </Badge>
                  {t.siguiente && (
                    <Link
                      href={t.siguiente.href}
                      className="text-primary text-xs font-medium hover:underline"
                    >
                      {t.siguiente.label}
                    </Link>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => abrir(t)}>
                      Editar
                    </Button>
                    {borrar === t.id ? (
                      <>
                        <Button size="sm" variant="destructive" onClick={() => void eliminar(t.id)}>
                          Sí, eliminar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setBorrar(null)}>
                          No
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-400 hover:text-rose-300"
                        onClick={() => setBorrar(t.id)}
                      >
                        Eliminar
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.09em] uppercase">
          Disponibles {disponibles.length}
        </p>
        {disponibles.length === 0 ? (
          <p className="text-muted-foreground text-sm">No hay más integraciones en esta categoría.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {disponibles.map((t) => {
              const Icono = t.icono;
              return (
                <div
                  key={t.id}
                  className={cn(
                    'bg-card relative flex flex-col rounded-xl border p-5',
                    t.novedad ? 'border-primary/50' : 'border-border',
                  )}
                >
                  {t.novedad && (
                    <Badge className="absolute -top-2.5 right-4 text-[10px]">NOVEDAD</Badge>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
                      <Icono className="size-5" />
                    </span>
                    <Badge variant="outline" className="text-muted-foreground text-[10px]">
                      {t.etiqueta}
                    </Badge>
                  </div>
                  <h3
                    className={cn(
                      'mt-4 text-base font-semibold',
                      t.novedad && 'text-primary',
                    )}
                  >
                    {t.titulo}
                  </h3>
                  <p className="text-muted-foreground mt-1 flex-1 text-sm">{t.descripcion}</p>
                  <div className="border-border mt-4 flex justify-end border-t pt-4">
                    <Button size="sm" variant="secondary" onClick={() => abrir(t)}>
                      Configurar
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Integraciones propias del WaCRM (viven dentro de esta sección). */}
      <section className="space-y-2">
        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.09em] uppercase">
          Más integraciones del WaCRM
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {MAS.map((m) => (
            <Link
              key={m.tab}
              href={`/settings?tab=${m.tab}`}
              className="bg-card border-border hover:border-primary/50 flex items-start gap-3 rounded-xl border p-4 transition-colors"
            >
              <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                <m.icono className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{m.titulo}</span>
                <span className="text-muted-foreground block text-xs">{m.texto}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <Dialog open={Boolean(abierta)} onOpenChange={(v) => !v && setAbierta(null)}>
        {abierta && (
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{abierta.modal.titulo}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {abierta.modal.descripcion}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {abierta.modal.nombre && (
                <div>
                  <Label className="text-muted-foreground mb-1 block text-xs">
                    {abierta.modal.nombre.label}
                  </Label>
                  <Input
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                    className="bg-muted"
                    placeholder={abierta.modal.nombre.placeholder}
                  />
                </div>
              )}
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {abierta.modal.clave.label}
                </Label>
                <div className="relative">
                  <Input
                    type={ver ? 'text' : 'password'}
                    value={clave}
                    onChange={(e) => setClave(e.target.value)}
                    className="bg-muted pr-9 font-mono text-xs"
                    placeholder={
                      editando
                        ? 'Deja vacío para conservar la actual'
                        : abierta.modal.clave.placeholder
                    }
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setVer((v) => !v)}
                    className="text-muted-foreground absolute top-1/2 right-2.5 -translate-y-1/2"
                    aria-label={ver ? 'Ocultar' : 'Mostrar'}
                  >
                    {ver ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {abierta.modal.ayuda && (
                  <p className="text-muted-foreground mt-1.5 text-[11px]">
                    {abierta.modal.ayuda.texto}{' '}
                    <a
                      href={abierta.modal.ayuda.enlace}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {abierta.modal.ayuda.label}
                    </a>
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierta(null)}>
                Cancelar
              </Button>
              <Button
                onClick={() => void guardar()}
                disabled={guardando || (!clave.trim() && !editando)}
              >
                {guardando && <Loader2 className="size-4 animate-spin" />}
                {abierta.id === 'dapi' ? 'Guardar clave' : 'Guardar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
