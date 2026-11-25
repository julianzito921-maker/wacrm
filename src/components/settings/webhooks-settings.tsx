'use client';

// ============================================================
// WebhooksSettings — Configuración → Webhooks
//
// Webhooks SALIENTES: el CRM avisa por POST firmado a una URL tuya
// (Make, n8n, Zapier, tu servidor…) cuando entra un mensaje, cambia
// el estado de uno enviado o se abre una conversación. Cualquier
// miembro ve la lista; admin+ crea, edita, prueba, rota el secreto y
// borra (RequireRole aquí + requireRole y RLS en el servidor).
//
// El secreto de firma se muestra UNA sola vez (al crear o al rotar):
// el servidor solo guarda una copia cifrada y no lo devuelve otra vez.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Copy,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks/events';
import { SettingsPanelHead } from './settings-panel-head';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

type TestResult =
  | { ok: true; status: number; ms: number }
  | {
      ok: false;
      reason: 'blocked_url' | 'secret' | 'http' | 'network';
      status?: number;
      ms: number;
    };

/** Igual que MAX_CONSECUTIVE_FAILURES de lib/webhooks/deliver.ts. */
const AUTO_DISABLE_AT = 15;

/** Clave i18n de cada evento (los puntos no valen en claves next-intl). */
const EVENT_KEY: Record<WebhookEvent, string> = {
  'message.received': 'messageReceived',
  'message.status_updated': 'messageStatusUpdated',
  'conversation.created': 'conversationCreated',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function estado(w: WebhookEndpoint): 'active' | 'paused' | 'autoDisabled' {
  if (w.is_active) return 'active';
  return w.failure_count >= AUTO_DISABLE_AT ? 'autoDisabled' : 'paused';
}

async function leerError(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return payload.error || fallback;
}

export function WebhooksSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.webhooks');

  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
      if (!res.ok) {
        toast.error(await leerError(res, t('loadFailed')));
        return;
      }
      const data = (await res.json()) as { webhooks: WebhookEndpoint[] };
      setWebhooks(data.webhooks);
    } catch (err) {
      console.error('[WebhooksSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function reemplazar(w: WebhookEndpoint) {
    setWebhooks((prev) => prev.map((x) => (x.id === w.id ? w : x)));
  }

  async function toggleActive(w: WebhookEndpoint, next: boolean) {
    setBusy(w.id);
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        toast.error(await leerError(res, t('updateFailed')));
        return;
      }
      const data = (await res.json()) as { webhook: WebhookEndpoint };
      reemplazar(data.webhook);
      toast.success(next ? t('enabled') : t('disabled'));
    } catch {
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(w: WebhookEndpoint) {
    setBusy(w.id);
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}/test`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(await leerError(res, t('testFailed')));
        return;
      }
      const { result } = (await res.json()) as { result: TestResult };
      if (result.ok) {
        toast.success(t('testOk', { status: result.status, ms: result.ms }));
      } else if (result.reason === 'http') {
        toast.error(t('testHttp', { status: result.status ?? 0 }));
      } else if (result.reason === 'blocked_url') {
        toast.error(t('testBlocked'));
      } else if (result.reason === 'secret') {
        toast.error(t('testSecret'));
      } else {
        toast.error(t('testNetwork'));
      }
    } catch {
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function rotateSecret(w: WebhookEndpoint) {
    setBusy(w.id);
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}/rotate-secret`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(await leerError(res, t('rotateFailed')));
        return;
      }
      const { secret } = (await res.json()) as { secret: string };
      setRevealed(secret);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    const w = deleting;
    if (!w) return;
    setBusy(w.id);
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error(await leerError(res, t('deleteFailed')));
        return;
      }
      setWebhooks((prev) => prev.filter((x) => x.id !== w.id));
      toast.success(t('deleted'));
      setDeleting(null);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const code = (chunks: ReactNode) => <code className="text-xs">{chunks}</code>;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              {t('newWebhook')}
            </Button>
          </RequireRole>
        }
      />

      {webhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {canEditSettings ? t('emptyHint') : t('askAdminHint')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {webhooks.map((w) => {
                const st = estado(w);
                const ocupado = busy === w.id;
                return (
                  <li
                    key={w.id}
                    className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`truncate font-mono text-xs ${
                            st === 'active'
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                          }`}
                          title={w.url}
                        >
                          {w.url}
                        </span>
                        {st === 'active' && (
                          <Badge className="border-emerald-500/40 bg-emerald-500/10 text-[10px] tracking-wide text-emerald-300 uppercase">
                            {t('statusActive')}
                          </Badge>
                        )}
                        {st === 'paused' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('statusPaused')}
                          </Badge>
                        )}
                        {st === 'autoDisabled' && (
                          <Badge className="border-red-500/40 bg-red-500/10 text-[10px] tracking-wide text-red-300 uppercase">
                            {t('statusAutoDisabled')}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {w.events.map((e) => (
                          <Badge
                            key={e}
                            className="border-border bg-muted text-muted-foreground font-mono text-[10px]"
                          >
                            {e}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        {w.last_delivery_at
                          ? t('lastDelivery', {
                              date: fmtDateTime(w.last_delivery_at),
                            })
                          : t('neverDelivered')}
                        {w.failure_count > 0
                          ? ` · ${t('failures', { count: w.failure_count })}`
                          : ''}
                      </p>
                    </div>

                    <RequireRole min="admin">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-muted-foreground mr-1 flex items-center gap-2 text-xs">
                          <Switch
                            checked={w.is_active}
                            disabled={ocupado}
                            onCheckedChange={(next) => toggleActive(w, next)}
                            aria-label={t('toggleLabel')}
                          />
                          <span>{w.is_active ? t('on') : t('off')}</span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ocupado}
                          onClick={() => sendTest(w)}
                        >
                          {ocupado ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                          {t('test')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ocupado}
                          onClick={() => setEditing(w)}
                        >
                          <Pencil className="size-4" />
                          {t('edit')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ocupado}
                          onClick={() => rotateSecret(w)}
                        >
                          <RefreshCw className="size-4" />
                          {t('rotate')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ocupado}
                          onClick={() => setDeleting(w)}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          <Trash2 className="size-4" />
                          {t('delete')}
                        </Button>
                      </div>
                    </RequireRole>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Cómo verificar las entregas en el receptor. */}
      <Card>
        <CardContent className="space-y-3 py-4 text-sm">
          <p className="text-foreground font-medium">{t('howTitle')}</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
            <li>{t.rich('howHeaders', { code })}</li>
            <li>{t.rich('howSignature', { code })}</li>
            <li>{t('howRetries', { max: AUTO_DISABLE_AT })}</li>
            <li>{t.rich('howTest', { code })}</li>
          </ul>
          <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md p-3 text-[11px] leading-relaxed">
            {VERIFY_SNIPPET}
          </pre>
        </CardContent>
      </Card>

      <WebhookDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(w, secret) => {
          setEditing(null);
          setWebhooks((prev) =>
            prev.some((x) => x.id === w.id)
              ? prev.map((x) => (x.id === w.id ? w : x))
              : [w, ...prev]
          );
          if (secret) setRevealed(secret);
          else toast.success(t('saved'));
        }}
      />

      <SecretDialog secret={revealed} onClose={() => setRevealed(null)} />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground break-all">
              {t('deleteDesc', { url: deleting?.url ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleting !== null && busy === deleting.id}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const VERIFY_SNIPPET = `// Node.js: verificar X-Wacrm-Signature con el cuerpo CRUDO
const crypto = require('crypto');
function firmaValida(rawBody, header, secret) {
  const p = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=')));
  const t = Number(p.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false; // 5 min
  const esperado = crypto.createHmac('sha256', secret)
    .update(t + '.' + rawBody).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(p.v1 || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}`;

// ------------------------------------------------------------
// Crear / editar: URL + eventos.
// ------------------------------------------------------------

function WebhookDialog({
  target,
  onClose,
  onSaved,
}: {
  target: WebhookEndpoint | 'new' | null;
  onClose: () => void;
  onSaved: (w: WebhookEndpoint, secret: string | null) => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const isNew = target === 'new';
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Cargar los valores al abrir.
  useEffect(() => {
    if (target === null) return;
    if (target === 'new') {
      setUrl('');
      setEvents(['message.received']);
    } else {
      setUrl(target.url);
      setEvents(
        target.events.filter((e): e is WebhookEvent =>
          (WEBHOOK_EVENTS as readonly string[]).includes(e)
        )
      );
    }
    setSubmitting(false);
  }, [target]);

  function toggle(e: WebhookEvent, checked: boolean) {
    setEvents((prev) =>
      checked ? [...prev, e] : prev.filter((x) => x !== e)
    );
  }

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed.startsWith('https://')) {
      toast.error(t('urlHttps'));
      return;
    }
    if (events.length === 0) {
      toast.error(t('eventsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        isNew ? '/api/account/webhooks' : `/api/account/webhooks/${(target as WebhookEndpoint).id}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Al editar, la URL solo se manda si cambió: así cambiar
          // eventos no borra la racha de fallos.
          body: JSON.stringify(
            isNew || trimmed !== (target as WebhookEndpoint).url
              ? { url: trimmed, events }
              : { events }
          ),
        }
      );
      if (!res.ok) {
        toast.error(await leerError(res, t('saveFailed')));
        return;
      }
      const data = (await res.json()) as {
        webhook: WebhookEndpoint;
        secret?: string;
      };
      onSaved(data.webhook, data.secret ?? null);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isNew ? t('newTitle') : t('editTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('formDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="webhook-url" className="text-muted-foreground">
              {t('urlLabel')}
            </Label>
            <Input
              id="webhook-url"
              value={url}
              inputMode="url"
              placeholder="https://hook.make.com/…"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('eventsLabel')}</Label>
            <div className="border-border space-y-2 rounded-md border p-3">
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={events.includes(e)}
                    onCheckedChange={(checked) => toggle(e, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block font-mono text-xs">
                      {e}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {t(`events.${EVENT_KEY[e]}`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : isNew ? (
              t('create')
            ) : (
              t('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Revelación única del secreto (al crear o al rotar).
// ------------------------------------------------------------

function SecretDialog({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.webhooks');

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('secretTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('secretDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label className="text-muted-foreground">{t('secretLabel')}</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={secret ?? ''}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={copy}>
              <Copy className="size-4" />
              {t('copy')}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
