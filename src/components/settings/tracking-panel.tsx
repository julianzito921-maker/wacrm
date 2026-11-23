'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, Link2, Loader2, Pencil, Plus, Target, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  LINK_PLATFORMS,
  TRACKING_PLATFORMS,
  slugify,
  type LinkPlatform,
  type TrackingPlatform,
} from '@/lib/tracking/links';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

interface Pixel {
  id: string;
  platform: TrackingPlatform;
  name: string;
  pixel_id: string;
  test_event_code: string | null;
  purchase_stage_id: string | null;
  active: boolean;
  has_token: boolean;
  created_at: string;
}

interface Enlace {
  id: string;
  name: string;
  slug: string;
  platform: LinkPlatform;
  phone_number: string | null;
  prefilled_text: string | null;
  default_utm: Record<string, string> | null;
  active: boolean;
  created_at: string;
  url: string;
}

interface Etapa {
  id: string;
  pipeline_id: string;
  name: string;
}

interface Pipeline {
  id: string;
  name: string;
}

type Confirmacion = { tipo: 'pixel' | 'enlace'; id: string } | null;

const FORM_PIXEL = {
  platform: 'meta' as string,
  name: '',
  pixel_id: '',
  access_token: '',
  test_event_code: '',
  purchase_stage_id: '',
  active: true,
};

const FORM_ENLACE = {
  name: '',
  slug: '',
  platform: 'meta' as string,
  prefilled_text: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  active: true,
};

export function TrackingPanel() {
  const t = useTranslations('Settings.tracking');
  const { canEditSettings, profileLoading } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [cargando, setCargando] = useState(true);
  const [pixels, setPixels] = useState<Pixel[]>([]);
  const [enlaces, setEnlaces] = useState<Enlace[]>([]);
  const [confirmar, setConfirmar] = useState<Confirmacion>(null);

  const [pixelOpen, setPixelOpen] = useState(false);
  const [pixelEdit, setPixelEdit] = useState<Pixel | null>(null);
  const [pForm, setPForm] = useState({ ...FORM_PIXEL });
  const [etapas, setEtapas] = useState<Etapa[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkEdit, setLinkEdit] = useState<Enlace | null>(null);
  const [lForm, setLForm] = useState({ ...FORM_ENLACE });
  const [slugTocado, setSlugTocado] = useState(false);
  const [telefono, setTelefono] = useState<string | null>(null);
  const [telefonoCargando, setTelefonoCargando] = useState(false);

  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [rp, rl] = await Promise.all([
        fetch('/api/settings/tracking/pixels'),
        fetch('/api/settings/tracking/links'),
      ]);
      if (!rp.ok || !rl.ok) throw new Error('load');
      const [jp, jl] = await Promise.all([rp.json(), rl.json()]);
      setPixels((jp.pixels ?? []) as Pixel[]);
      setEnlaces((jl.links ?? []) as Enlace[]);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      const [{ data: p }, { data: s }] = await Promise.all([
        supabase.from('pipelines').select('id, name').order('created_at'),
        supabase
          .from('pipeline_stages')
          .select('id, pipeline_id, name, position')
          .order('position'),
      ]);
      if (!vivo) return;
      setPipelines((p ?? []) as Pipeline[]);
      setEtapas((s ?? []) as Etapa[]);
    })();
    return () => {
      vivo = false;
    };
  }, [supabase]);

  useEffect(() => {
    if (!linkOpen) return;
    let vivo = true;
    setTelefonoCargando(true);
    void (async () => {
      try {
        const res = await fetch('/api/whatsapp/health');
        const json = await res.json();
        if (vivo) {
          setTelefono(json?.state === 'connected' ? json.displayPhoneNumber ?? null : null);
        }
      } catch {
        if (vivo) setTelefono(null);
      } finally {
        if (vivo) setTelefonoCargando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [linkOpen]);

  const errorDe = (code: string): string => {
    const mapa: Record<string, string> = {
      duplicate_pixel: t('errors.duplicatePixel'),
      missing_fields: t('errors.missingFields'),
      missing_name: t('errors.missingFields'),
      invalid_stage: t('errors.invalidStage'),
      whatsapp_disconnected: t('errors.whatsappDisconnected'),
      phone_unavailable: t('errors.phoneUnavailable'),
      slug_taken: t('errors.slugTaken'),
      invalid_slug: t('errors.invalidSlug'),
      invalid_platform: t('errors.invalidPlatform'),
    };
    return mapa[code] ?? t('errors.generic');
  };

  const abrirNuevoPixel = () => {
    setPixelEdit(null);
    setPForm({ ...FORM_PIXEL });
    setPixelOpen(true);
  };

  const abrirEditarPixel = (p: Pixel) => {
    setPixelEdit(p);
    setPForm({
      platform: p.platform,
      name: p.name,
      pixel_id: p.pixel_id,
      access_token: '',
      test_event_code: p.test_event_code ?? '',
      purchase_stage_id: p.purchase_stage_id ?? '',
      active: p.active,
    });
    setPixelOpen(true);
  };

  const guardarPixel = async () => {
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        platform: pForm.platform,
        name: pForm.name.trim(),
        pixel_id: pForm.pixel_id.trim(),
        test_event_code: pForm.test_event_code.trim() || null,
        purchase_stage_id:
          pForm.platform === 'meta' ? pForm.purchase_stage_id || null : null,
        active: pForm.active,
      };
      if (pForm.access_token.trim()) body.access_token = pForm.access_token.trim();
      if (!pixelEdit && !body.access_token) {
        toast.error(t('errors.missingFields'));
        return;
      }
      const res = await fetch(
        pixelEdit
          ? `/api/settings/tracking/pixels/${pixelEdit.id}`
          : '/api/settings/tracking/pixels',
        {
          method: pixelEdit ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'generic');
      }
      toast.success(pixelEdit ? t('pixels.saved') : t('pixels.created'));
      setPixelOpen(false);
      await cargar();
    } catch (err) {
      toast.error(errorDe(err instanceof Error ? err.message : 'generic'));
    } finally {
      setGuardando(false);
    }
  };

  const alternarPixel = async (p: Pixel, activo: boolean) => {
    setPixels((prev) => prev.map((x) => (x.id === p.id ? { ...x, active: activo } : x)));
    const res = await fetch(`/api/settings/tracking/pixels/${p.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: activo }),
    });
    if (!res.ok) {
      setPixels((prev) => prev.map((x) => (x.id === p.id ? { ...x, active: !activo } : x)));
      toast.error(t('errors.generic'));
    }
  };

  const abrirNuevoEnlace = () => {
    setLinkEdit(null);
    setLForm({ ...FORM_ENLACE });
    setSlugTocado(false);
    setLinkOpen(true);
  };

  const abrirEditarEnlace = (l: Enlace) => {
    setLinkEdit(l);
    setLForm({
      name: l.name,
      slug: l.slug,
      platform: l.platform,
      prefilled_text: l.prefilled_text ?? '',
      utm_source: l.default_utm?.utm_source ?? '',
      utm_medium: l.default_utm?.utm_medium ?? '',
      utm_campaign: l.default_utm?.utm_campaign ?? '',
      active: l.active,
    });
    setSlugTocado(true);
    setLinkOpen(true);
  };

  const guardarEnlace = async () => {
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        name: lForm.name.trim(),
        slug: lForm.slug.trim() || slugify(lForm.name),
        platform: lForm.platform,
        prefilled_text: lForm.prefilled_text.trim() || null,
        default_utm: {
          ...(lForm.utm_source.trim() ? { utm_source: lForm.utm_source.trim() } : {}),
          ...(lForm.utm_medium.trim() ? { utm_medium: lForm.utm_medium.trim() } : {}),
          ...(lForm.utm_campaign.trim() ? { utm_campaign: lForm.utm_campaign.trim() } : {}),
        },
        active: lForm.active,
      };
      const res = await fetch(
        linkEdit
          ? `/api/settings/tracking/links/${linkEdit.id}`
          : '/api/settings/tracking/links',
        {
          method: linkEdit ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'generic');
      }
      toast.success(linkEdit ? t('links.saved') : t('links.created'));
      setLinkOpen(false);
      await cargar();
    } catch (err) {
      toast.error(errorDe(err instanceof Error ? err.message : 'generic'));
    } finally {
      setGuardando(false);
    }
  };

  const alternarEnlace = async (l: Enlace, activo: boolean) => {
    setEnlaces((prev) => prev.map((x) => (x.id === l.id ? { ...x, active: activo } : x)));
    const res = await fetch(`/api/settings/tracking/links/${l.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: activo }),
    });
    if (!res.ok) {
      setEnlaces((prev) => prev.map((x) => (x.id === l.id ? { ...x, active: !activo } : x)));
      toast.error(t('errors.generic'));
    }
  };

  const borrar = async (tipo: 'pixel' | 'enlace', id: string) => {
    const ruta =
      tipo === 'pixel'
        ? `/api/settings/tracking/pixels/${id}`
        : `/api/settings/tracking/links/${id}`;
    const res = await fetch(ruta, { method: 'DELETE' });
    setConfirmar(null);
    if (!res.ok) {
      toast.error(t('errors.generic'));
      return;
    }
    toast.success(t('deleted'));
    await cargar();
  };

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t('copied'));
    } catch {
      toast.error(t('errors.generic'));
    }
  };

  const editable = canEditSettings && !profileLoading;

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Target className="size-4 text-primary" />
              {t('pixels.title')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('pixels.description')}
            </CardDescription>
          </div>
          <Button size="sm" onClick={abrirNuevoPixel} disabled={!editable}>
            <Plus className="size-4" />
            {t('pixels.new')}
          </Button>
        </CardHeader>
        <CardContent>
          {cargando ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('loading')}
            </div>
          ) : pixels.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Target className="text-muted-foreground size-6" />
              </span>
              <p className="text-sm font-medium text-foreground">
                {t('pixels.emptyTitle')}
              </p>
              <p className="text-muted-foreground max-w-sm text-xs">
                {t('pixels.emptyDesc')}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={abrirNuevoPixel}
                disabled={!editable}
              >
                <Plus className="size-4" />
                {t('pixels.new')}
              </Button>
            </div>
          ) : (
            <ul className="divide-border divide-y">
              {pixels.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Badge variant="secondary" className="uppercase">
                    {t(`platforms.${p.platform}`)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {p.name}
                    </p>
                    <p className="text-muted-foreground truncate font-mono text-[11px]">
                      {p.pixel_id} ·{' '}
                      {p.has_token ? t('pixels.tokenConfigured') : t('pixels.tokenMissing')}
                      {p.test_event_code ? ` · ${p.test_event_code}` : ''}
                    </p>
                  </div>
                  {confirmar?.tipo === 'pixel' && confirmar.id === p.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-[11px]">
                        {t('confirmDelete')}
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => void borrar('pixel', p.id)}
                      >
                        {t('yes')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmar(null)}
                      >
                        {t('no')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={p.active}
                        onCheckedChange={(v) => void alternarPixel(p, v === true)}
                        disabled={!editable}
                        aria-label={t('active')}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => abrirEditarPixel(p)}
                        disabled={!editable}
                        aria-label={t('edit')}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfirmar({ tipo: 'pixel', id: p.id })}
                        disabled={!editable}
                        aria-label={t('delete')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Link2 className="size-4 text-primary" />
              {t('links.title')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('links.description')}
            </CardDescription>
          </div>
          <Button size="sm" onClick={abrirNuevoEnlace} disabled={!editable}>
            <Plus className="size-4" />
            {t('links.new')}
          </Button>
        </CardHeader>
        <CardContent>
          {cargando ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('loading')}
            </div>
          ) : enlaces.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <Link2 className="text-muted-foreground size-6" />
              </span>
              <p className="text-sm font-medium text-foreground">
                {t('links.emptyTitle')}
              </p>
              <p className="text-muted-foreground max-w-sm text-xs">
                {t('links.emptyDesc')}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={abrirNuevoEnlace}
                disabled={!editable}
              >
                <Plus className="size-4" />
                {t('links.new')}
              </Button>
            </div>
          ) : (
            <ul className="divide-border divide-y">
              {enlaces.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Badge variant="outline" className="uppercase">
                    {t(`platforms.${l.platform}`)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {l.name}
                    </p>
                    <p className="text-muted-foreground truncate font-mono text-[11px]">
                      {l.url}
                    </p>
                    {l.phone_number && (
                      <p className="text-muted-foreground text-[11px]">
                        +{l.phone_number}
                      </p>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void copiar(l.url)}
                    aria-label={t('links.copy')}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  {confirmar?.tipo === 'enlace' && confirmar.id === l.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-[11px]">
                        {t('confirmDelete')}
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => void borrar('enlace', l.id)}
                      >
                        {t('yes')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmar(null)}
                      >
                        {t('no')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={l.active}
                        onCheckedChange={(v) => void alternarEnlace(l, v === true)}
                        disabled={!editable}
                        aria-label={t('active')}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => abrirEditarEnlace(l)}
                        disabled={!editable}
                        aria-label={t('edit')}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfirmar({ tipo: 'enlace', id: l.id })}
                        disabled={!editable}
                        aria-label={t('delete')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={pixelOpen} onOpenChange={setPixelOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {pixelEdit ? t('pixels.editTitle') : t('pixels.newTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('pixels.formDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('platform')}
              </Label>
              <Select
                value={pForm.platform}
                onValueChange={(v) => setPForm((f) => ({ ...f, platform: v ?? 'meta' }))}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRACKING_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`platforms.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('pixels.name')}
              </Label>
              <Input
                value={pForm.name}
                onChange={(e) => setPForm((f) => ({ ...f, name: e.target.value }))}
                className="bg-muted"
              />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {pForm.platform === 'meta' ? t('pixels.datasetId') : t('pixels.pixelId')}
              </Label>
              <Input
                value={pForm.pixel_id}
                onChange={(e) => setPForm((f) => ({ ...f, pixel_id: e.target.value }))}
                className="bg-muted font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('pixels.token')}
              </Label>
              <Input
                type="password"
                value={pForm.access_token}
                onChange={(e) =>
                  setPForm((f) => ({ ...f, access_token: e.target.value }))
                }
                placeholder={
                  pixelEdit ? t('pixels.tokenKeep') : t('pixels.tokenPlaceholder')
                }
                className="bg-muted font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('pixels.testCode')}
              </Label>
              <Input
                value={pForm.test_event_code}
                onChange={(e) =>
                  setPForm((f) => ({ ...f, test_event_code: e.target.value }))
                }
                className="bg-muted font-mono text-xs"
                placeholder="TEST12345"
              />
              <p className="text-muted-foreground mt-1 text-[10px]">
                {t('pixels.testCodeHelp')}
              </p>
            </div>

            {pForm.platform === 'meta' && (
              <>
                <div>
                  <Label className="text-muted-foreground mb-1 block text-xs">
                    {t('pixels.purchaseStage')}
                  </Label>
                  <select
                    value={pForm.purchase_stage_id}
                    onChange={(e) =>
                      setPForm((f) => ({ ...f, purchase_stage_id: e.target.value }))
                    }
                    className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
                  >
                    <option value="">{t('pixels.noStage')}</option>
                    {pipelines.map((p) => (
                      <optgroup key={p.id} label={p.name}>
                        {etapas
                          .filter((s) => s.pipeline_id === p.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <p className="text-muted-foreground mt-1 text-[10px]">
                    {t('pixels.purchaseStageHelp')}
                  </p>
                </div>
                <p className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-lg border p-2.5 text-[11px] leading-snug">
                  {t('pixels.metaNote')}
                </p>
              </>
            )}

            <div className="flex items-center justify-between gap-3">
              <span className="text-foreground text-xs">{t('active')}</span>
              <Switch
                checked={pForm.active}
                onCheckedChange={(v) => setPForm((f) => ({ ...f, active: v === true }))}
                aria-label={t('active')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPixelOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void guardarPixel()} disabled={guardando}>
              {guardando && <Loader2 className="size-4 animate-spin" />}
              {pixelEdit ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {linkEdit ? t('links.editTitle') : t('links.newTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('links.formDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
            {!telefonoCargando && !telefono && (
              <p className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-2.5 text-[11px]">
                {t('links.disconnected')}
              </p>
            )}
            {telefono && (
              <p className="text-muted-foreground text-[11px]">
                {t('links.connectedAs', { phone: telefono })}
              </p>
            )}
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('links.name')}
              </Label>
              <Input
                value={lForm.name}
                onChange={(e) => {
                  const value = e.target.value;
                  setLForm((f) => ({
                    ...f,
                    name: value,
                    ...(slugTocado ? {} : { slug: slugify(value) }),
                  }));
                }}
                className="bg-muted"
              />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('links.slug')}
              </Label>
              <Input
                value={lForm.slug}
                onChange={(e) => {
                  setSlugTocado(true);
                  setLForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }));
                }}
                className="bg-muted font-mono text-xs"
              />
              <p className="text-muted-foreground mt-1 text-[10px]">
                {t('links.slugHelp')}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('platform')}
              </Label>
              <Select
                value={lForm.platform}
                onValueChange={(v) => setLForm((f) => ({ ...f, platform: v ?? 'meta' }))}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINK_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`platforms.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('links.prefilled')}
              </Label>
              <Input
                value={lForm.prefilled_text}
                onChange={(e) =>
                  setLForm((f) => ({ ...f, prefilled_text: e.target.value }))
                }
                className="bg-muted"
                placeholder={t('links.prefilledPlaceholder')}
              />
              <p className="text-muted-foreground mt-1 text-[10px]">
                {t('links.prefilledHelp')}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {t('links.utmSource')}
                </Label>
                <Input
                  value={lForm.utm_source}
                  onChange={(e) =>
                    setLForm((f) => ({ ...f, utm_source: e.target.value }))
                  }
                  className="bg-muted text-xs"
                />
              </div>
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {t('links.utmMedium')}
                </Label>
                <Input
                  value={lForm.utm_medium}
                  onChange={(e) =>
                    setLForm((f) => ({ ...f, utm_medium: e.target.value }))
                  }
                  className="bg-muted text-xs"
                />
              </div>
              <div>
                <Label className="text-muted-foreground mb-1 block text-xs">
                  {t('links.utmCampaign')}
                </Label>
                <Input
                  value={lForm.utm_campaign}
                  onChange={(e) =>
                    setLForm((f) => ({ ...f, utm_campaign: e.target.value }))
                  }
                  className="bg-muted text-xs"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-foreground text-xs">{t('active')}</span>
              <Switch
                checked={lForm.active}
                onCheckedChange={(v) => setLForm((f) => ({ ...f, active: v === true }))}
                aria-label={t('active')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void guardarEnlace()}
              disabled={guardando || (!telefono && !linkEdit)}
            >
              {guardando && <Loader2 className="size-4 animate-spin" />}
              {linkEdit ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
