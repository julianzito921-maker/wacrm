'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  QrCode,
  BadgeCheck,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  WifiOff,
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
import { Switch } from '@/components/ui/switch';
import { estadoCalentamiento } from '@/lib/whatsapp/warmup';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { OficialesDapiDialog } from './oficiales-dapi-dialog';

interface Connection {
  id: string;
  name: string;
  phone_number: string | null;
  phone_number_id: string;
  waba_id: string | null;
  status: 'connected' | 'disconnected';
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  whatsapp_business_manager_messaging_limit: string | null;
  display_phone_number: string | null;
  health_status: string | null;
  health_reason: string | null;
  warmup_enabled: boolean | null;
  warmup_started_at: string | null;
  badge_color: string;
  tracking_pixel_id: string | null;
  custom_domain: string | null;
  is_default: boolean;
  active: boolean;
  last_synced_at: string | null;
  created_at: string;
}

const FORM = {
  name: '',
  phone_number_id: '',
  waba_id: '',
  access_token: '',
  verify_token: '',
  app_secret: '',
  badge_color: '#6366f1',
  tracking_pixel_id: '',
  custom_domain: '',
  is_default: false,
  active: true,
};

const COLORES = ['#6366f1', '#8b5cf6', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4'];

interface Pixel {
  id: string;
  name: string;
  pixel_id: string;
}

function calidadClase(q: string | null) {
  if (q === 'GREEN') return 'border-emerald-500/30 text-emerald-300';
  if (q === 'YELLOW') return 'border-amber-500/30 text-amber-300';
  if (q === 'RED') return 'border-rose-500/30 text-rose-300';
  return 'border-slate-500/30 text-slate-300';
}

/** Isla D-API (WhatsApp Web por QR): phone_number_id = 'dapi:<sesion>'. */
function esDapi(c: Pick<Connection, 'phone_number_id'>) {
  return c.phone_number_id.startsWith('dapi:');
}

/** Número oficial (Cloud API) con D-API como proveedor: sesión «cloud-…». */
function esOficialDapi(c: Pick<Connection, 'phone_number_id'>) {
  return c.phone_number_id.startsWith('dapi:cloud-');
}

function tierTexto(t: string | null) {
  if (!t) return '—';
  return t.replace('TIER_', '').replace('_', ',');
}

export function ConnectionsView() {
  const t = useTranslations('Connections');
  const [conexiones, setConexiones] = useState<Connection[]>([]);
  const [pixels, setPixels] = useState<Pixel[]>([]);
  const [warmupPending, setWarmupPending] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/tracking/pixels');
        const json = (await res.json()) as { pixels?: Pixel[] };
        if (!cancelado && res.ok) setPixels(json.pixels ?? []);
      } catch {
        // la lista de píxeles es opcional para crear la conexión
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<'all' | 'connected' | 'disconnected'>('all');
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Connection | null>(null);
  const [form, setForm] = useState({ ...FORM });
  const [guardando, setGuardando] = useState(false);
  const [sincronizando, setSincronizando] = useState<string | null>(null);
  const [borrar, setBorrar] = useState<string | null>(null);
  // Conectar por QR (D-API)
  const [qrAbierto, setQrAbierto] = useState(false);
  const [qrNombre, setQrNombre] = useState('');
  const [qrConexion, setQrConexion] = useState<string | null>(null);
  const [qrImagen, setQrImagen] = useState<string | null>(null);
  const [qrCreando, setQrCreando] = useState(false);
  const [oficialAbierto, setOficialAbierto] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/connections');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'load');
      setConexiones((json.connections ?? []) as Connection[]);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const alternarWarmup = async (c: Connection) => {
    setWarmupPending(c.id);
    try {
      const res = await fetch(`/api/connections/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warmup_enabled: !c.warmup_enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'update');
      setConexiones((prev) =>
        prev.map((x) =>
          x.id === c.id
            ? {
                ...x,
                warmup_enabled: !c.warmup_enabled,
                warmup_started_at:
                  !c.warmup_enabled && !x.warmup_started_at
                    ? new Date().toISOString()
                    : x.warmup_started_at,
              }
            : x,
        ),
      );
      toast.success(t('saved'));
    } catch {
      toast.error(t('genericError'));
    } finally {
      setWarmupPending(null);
    }
  };


  const abrirQr = (c?: Connection) => {
    setQrNombre('');
    setQrImagen(null);
    setQrConexion(c ? c.id : null);
    setQrAbierto(true);
  };

  const crearQr = async () => {
    if (!qrNombre.trim()) {
      toast.error(t('missingFields'));
      return;
    }
    setQrCreando(true);
    try {
      const res = await fetch('/api/connections/dapi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: qrNombre.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          json.error === 'dapi_not_configured'
            ? 'Primero guarda tu API Key de D-API en Configuración → Integraciones.'
            : json.error === 'dapi_error'
              ? `D-API: ${json.detail ?? ''}`
              : t('genericError'),
        );
        return;
      }
      setQrConexion((json.connection as Connection).id);
      await cargar();
    } finally {
      setQrCreando(false);
    }
  };

  // Mientras el QR está abierto se pide cada 4 s (D-API lo renueva solo)
  // hasta que el número quede conectado.
  useEffect(() => {
    if (!qrAbierto || !qrConexion) return;
    let vivo = true;
    const pedir = async () => {
      try {
        const res = await fetch(`/api/connections/${qrConexion}/qr`);
        const json = await res.json().catch(() => ({}));
        if (!vivo) return;
        if (!res.ok) {
          toast.error(json.detail ? `D-API: ${json.detail}` : t('genericError'));
          return;
        }
        if (json.connected) {
          toast.success('¡WhatsApp conectado!');
          setQrAbierto(false);
          await cargar();
          return;
        }
        setQrImagen(json.qr_image ?? null);
      } catch {
        // se reintenta en la siguiente vuelta
      }
    };
    void pedir();
    const intervalo = setInterval(() => void pedir(), 4000);
    return () => {
      vivo = false;
      clearInterval(intervalo);
    };
  }, [qrAbierto, qrConexion, cargar, t]);

  const conectadas = conexiones.filter((c) => c.status === 'connected').length;
  const desconectadas = conexiones.length - conectadas;

  const lista = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return conexiones.filter((c) => {
      if (filtro !== 'all' && c.status !== filtro) return false;
      if (!q) return true;
      return [c.name, c.phone_number, c.phone_number_id, c.waba_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [conexiones, busqueda, filtro]);

  const abrirNueva = () => {
    setEditando(null);
    setForm({ ...FORM });
    setAbierto(true);
  };

  const abrirEditar = (c: Connection) => {
    setEditando(c);
    setForm({
      name: c.name,
      phone_number_id: c.phone_number_id,
      waba_id: c.waba_id ?? '',
      access_token: '',
      verify_token: '',
      app_secret: '',
      badge_color: c.badge_color,
      tracking_pixel_id: c.tracking_pixel_id ?? '',
      custom_domain: c.custom_domain ?? '',
      is_default: c.is_default,
      active: c.active,
    });
    setAbierto(true);
  };

  const guardar = async () => {
    if (!form.name.trim() || !form.phone_number_id.trim()) {
      toast.error(t('missingFields'));
      return;
    }
    if (!editando && !form.access_token.trim()) {
      toast.error(t('missingToken'));
      return;
    }
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        waba_id: form.waba_id.trim() || null,
        badge_color: form.badge_color,
        tracking_pixel_id: form.tracking_pixel_id || null,
        custom_domain: form.custom_domain.trim() || null,
        is_default: form.is_default,
        active: form.active,
      };
      if (form.access_token.trim()) body.access_token = form.access_token.trim();
      if (form.verify_token.trim()) body.verify_token = form.verify_token.trim();
      if (form.app_secret.trim()) body.app_secret = form.app_secret.trim();
      if (!editando) body.phone_number_id = form.phone_number_id.trim();

      const res = await fetch(
        editando ? `/api/connections/${editando.id}` : '/api/connections',
        {
          method: editando ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.error === 'meta_error') {
          toast.error(t('metaError', { detail: json.detail ?? '' }));
        } else {
          toast.error(
            json.error === 'duplicate_phone' ? t('duplicate') : t('genericError'),
          );
        }
        return;
      }
      toast.success(editando ? t('saved') : t('created'));
      setAbierto(false);
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  const sincronizar = async (c: Connection) => {
    setSincronizando(c.id);
    try {
      const res = await fetch(`/api/connections/${c.id}/sync`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          json.error === 'meta_error'
            ? t('metaError', { detail: json.detail ?? '' })
            : t('genericError'),
        );
        return;
      }
      toast.success(t('synced'));
      await cargar();
    } finally {
      setSincronizando(null);
    }
  };

  const eliminar = async (id: string) => {
    const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    setBorrar(null);
    if (!res.ok) {
      toast.error(t('genericError'));
      return;
    }
    toast.success(t('deleted'));
    await cargar();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOficialAbierto(true)} className="bg-emerald-600 text-white hover:bg-emerald-700">
            <BadgeCheck className="size-4" />
            API Oficial (D-API)
          </Button>
          <Button variant="outline" onClick={() => abrirQr()}>
            <QrCode className="size-4" />
            Conectar por QR
          </Button>
          <Button onClick={abrirNueva}>
            <Plus className="size-4" />
            {t('new')}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <div className="flex items-center gap-2 text-emerald-300">
            <Wifi className="size-4" />
            <span className="text-xs font-medium">{t('connected')}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-emerald-300">{conectadas}</p>
        </div>
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
          <div className="flex items-center gap-2 text-rose-300">
            <WifiOff className="size-4" />
            <span className="text-xs font-medium">{t('disconnected')}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-rose-300">{desconectadas}</p>
        </div>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder={t('search')}
            className="bg-muted h-8 pl-8 text-xs"
          />
        </div>
        <div className="bg-muted flex rounded-lg p-0.5">
          {(['all', 'connected', 'disconnected'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFiltro(f)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium',
                filtro === f
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground',
              )}
            >
              {f === 'all' ? t('all') : f === 'connected' ? t('connected') : t('disconnected')}
            </button>
          ))}
        </div>
        <Button size="icon" variant="ghost" onClick={() => void cargar()} aria-label={t('refresh')}>
          <RefreshCw className={cn('size-4', cargando && 'animate-spin')} />
        </Button>
      </div>

      {cargando ? (
        <div className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : lista.length === 0 ? (
        <div className="border-border bg-card flex flex-col items-center gap-2 rounded-xl border py-12 text-center">
          <span className="bg-muted flex size-12 items-center justify-center rounded-full">
            <Wifi className="text-muted-foreground size-6" />
          </span>
          <p className="text-sm font-medium">{t('emptyTitle')}</p>
          <p className="text-muted-foreground max-w-sm text-xs">{t('emptyDesc')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={abrirNueva}>
            <Plus className="size-4" /> {t('new')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lista.map((c) => (
            <div
              key={c.id}
              className="overflow-hidden rounded-xl border border-indigo-500/25 bg-[#0b1020] text-slate-100 shadow-[0_18px_45px_-28px_rgba(79,70,229,0.7)]"
            >
              <div className="h-1.5 w-full" style={{ background: c.badge_color }} />
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ background: c.badge_color }}
                      />
                      <h3 className="truncate text-sm font-semibold">{c.name}</h3>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          c.status === 'connected'
                            ? 'border-emerald-400/40 text-emerald-300'
                            : 'border-rose-400/40 text-rose-300',
                        )}
                      >
                        {c.status === 'connected' ? t('connected') : t('disconnected')}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {c.phone_number ?? '—'} ·{' '}
                      {esOficialDapi(c) ? (
                        <span>D-API · Oficial</span>
                      ) : esDapi(c) ? (
                        <span>D-API · QR</span>
                      ) : (
                        <span className="font-mono">{c.phone_number_id}</span>
                      )}
                    </p>
                    {c.waba_id && (
                      <p className="text-[11px] text-slate-500">WABA {c.waba_id}</p>
                    )}
                  </div>
                  {esDapi(c) && !esOficialDapi(c) && c.status !== 'connected' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-emerald-400/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                    onClick={() => abrirQr(c)}
                  >
                    <QrCode className="size-3.5" />
                    Escanear QR
                  </Button>
                  ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-indigo-400/30 bg-indigo-500/10 text-indigo-100 hover:bg-indigo-500/20"
                    onClick={() => void sincronizar(c)}
                    disabled={sincronizando === c.id}
                  >
                    {sincronizando === c.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {t('sync')}
                  </Button>
                  )}
                </div>

                {(!esDapi(c) || esOficialDapi(c)) && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-indigo-400/20 bg-black/30 p-2.5">
                    <p className="text-[9px] tracking-wider text-slate-500 uppercase">
                      {t('quality')}
                    </p>
                    <Badge variant="outline" className={cn('mt-1 text-[10px]', calidadClase(c.quality_rating))}>
                      {c.quality_rating ?? '—'}
                    </Badge>
                  </div>
                  <div className="rounded-lg border border-indigo-400/20 bg-black/30 p-2.5">
                    <p className="text-[9px] tracking-wider text-slate-500 uppercase">
                      {t('limit')}
                    </p>
                  <p className="mt-1 text-sm font-semibold text-indigo-200">
                      {tierTexto(
                        c.whatsapp_business_manager_messaging_limit ??
                          c.messaging_limit_tier,
                      )}
                    </p>
                  </div>
                </div>
                )}

                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-indigo-400/20 bg-black/30 p-2.5">
                  <div>
                    <p className="text-[10px] text-slate-300">
                      Calentamiento progresivo
                    </p>
                    <p className="text-[9px] text-slate-500">
                      {(() => {
                        const estado = estadoCalentamiento(c);
                        if (!estado.habilitado) return 'Apagado';
                        if (estado.limite === null) return 'Completado (sin límite)';
                        return `Día ${estado.dia ?? 1} · ${estado.limite}/día`;
                      })()}
                    </p>
                  </div>
                  <Switch
                    checked={Boolean(c.warmup_enabled)}
                    disabled={warmupPending === c.id}
                    onCheckedChange={() => void alternarWarmup(c)}
                  />
                </div>

                {c.health_status && c.health_status !== 'healthy' ? (
                  <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-[10px] text-amber-200">
                    Salud: {c.health_status}
                    {c.health_reason ? ` · ${c.health_reason}` : ''}
                  </div>
                ) : null}


                <div className="mt-3 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-slate-500">
                    {t('lastSync')}:{' '}
                    {c.last_synced_at
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(new Date(c.last_synced_at))
                      : t('never')}
                  </p>
                  {borrar === c.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-400">{t('confirmDelete')}</span>
                      <Button size="sm" variant="destructive" onClick={() => void eliminar(c.id)}>
                        {t('yes')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setBorrar(null)}>
                        {t('no')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-slate-300 hover:text-white"
                        onClick={() => abrirEditar(c)}
                        aria-label={t('edit')}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-rose-300 hover:text-rose-200"
                        onClick={() => setBorrar(c.id)}
                        aria-label={t('delete')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <OficialesDapiDialog
        open={oficialAbierto}
        onOpenChange={setOficialAbierto}
        onConectado={() => void cargar()}
      />

      <Dialog open={qrAbierto} onOpenChange={setQrAbierto}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Conectar WhatsApp por QR</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              API Web (D-API). En tu celular: WhatsApp → Dispositivos vinculados → Vincular un
              dispositivo, y escanea el código.
            </DialogDescription>
          </DialogHeader>
          {qrConexion ? (
            <div className="flex flex-col items-center gap-3 py-2">
              {qrImagen ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrImagen}
                  alt="Código QR de WhatsApp"
                  className="size-64 rounded-lg bg-white p-2"
                />
              ) : (
                <div className="bg-muted flex size-64 items-center justify-center rounded-lg">
                  <Loader2 className="text-muted-foreground size-6 animate-spin" />
                </div>
              )}
              <p className="text-muted-foreground text-center text-[11px]">
                El código se renueva solo. Esta ventana se cierra cuando el número quede
                conectado.
              </p>
            </div>
          ) : (
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('name')}</Label>
              <Input
                value={qrNombre}
                onChange={(e) => setQrNombre(e.target.value)}
                className="bg-muted"
                placeholder="WhatsApp Ventas"
              />
              <p className="text-muted-foreground mt-2 text-[10px]">
                Conexión no oficial (WhatsApp Web): úsala con mensajes humanos, sin envíos
                masivos. Las plantillas y la calidad de Meta no aplican aquí.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setQrAbierto(false)}>
              {t('cancel')}
            </Button>
            {!qrConexion && (
              <Button onClick={() => void crearQr()} disabled={qrCreando}>
                {qrCreando && <Loader2 className="size-4 animate-spin" />}
                Generar QR
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editando ? t('editTitle') : t('newTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('formHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('name')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="bg-muted"
                placeholder="WhatsApp Ventas"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">{t('phoneNumberId')}</Label>
                <Input
                  value={form.phone_number_id}
                  onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
                  className="bg-muted font-mono text-xs"
                  disabled={Boolean(editando)}
                />
              </div>
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">{t('wabaId')}</Label>
                <Input
                  value={form.waba_id}
                  onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
                  className="bg-muted font-mono text-xs"
                />
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('accessToken')}</Label>
              <Input
                type="password"
                value={form.access_token}
                onChange={(e) => setForm((f) => ({ ...f, access_token: e.target.value }))}
                className="bg-muted font-mono text-xs"
                placeholder={editando ? t('keepToken') : 'EAAG…'}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">{t('appSecret')}</Label>
                <Input
                  type="password"
                  value={form.app_secret}
                  onChange={(e) => setForm((f) => ({ ...f, app_secret: e.target.value }))}
                  className="bg-muted font-mono text-xs"
                  placeholder={editando ? t('keepOptional') : t('optional')}
                />
              </div>
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">{t('verifyToken')}</Label>
                <Input
                  type="password"
                  value={form.verify_token}
                  onChange={(e) => setForm((f) => ({ ...f, verify_token: e.target.value }))}
                  className="bg-muted font-mono text-xs"
                  placeholder={editando ? t('keepOptional') : t('optional')}
                />
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('badgeColor')}</Label>
              <div className="flex flex-wrap gap-2">
                {COLORES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, badge_color: c }))}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-full border-2',
                      form.badge_color === c ? 'border-foreground' : 'border-transparent',
                    )}
                    style={{ background: c }}
                    aria-label={c}
                  >
                    {form.badge_color === c && <Check className="size-4 text-white" />}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                Píxel de Meta (CAPI)
              </Label>
              <select
                value={form.tracking_pixel_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tracking_pixel_id: e.target.value }))
                }
                className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-xs"
              >
                <option value="">Sin píxel vinculado</option>
                {pixels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.pixel_id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                Dominio propio (opcional)
              </Label>
              <Input
                value={form.custom_domain}
                onChange={(e) =>
                  setForm((f) => ({ ...f, custom_domain: e.target.value }))
                }
                className="bg-muted font-mono text-xs"
                placeholder="isla1.midominio.com"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  Conexión activa
                </span>
                <Switch
                  checked={form.active}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))}
                />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  Predeterminada
                </span>
                <Switch
                  checked={form.is_default}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, is_default: v }))}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-[10px]">{t('appSecretHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void guardar()} disabled={guardando}>
              {guardando && <Loader2 className="size-4 animate-spin" />}
              {editando ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
