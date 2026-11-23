'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BrainCircuit,
  Check,
  Copy,
  Globe,
  Loader2,
  Monitor,
  Plus,
  Server,
  Terminal,
  Trash2,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { MCP_SCOPES, type McpScope } from '@/lib/mcp/tokens';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsPanelHead } from './settings-panel-head';

interface Credencial {
  id: string;
  name: string;
  key_prefix: string;
  scopes: McpScope[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function formatearFecha(iso: string | null, nunca: string): string {
  if (!iso) return nunca;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function McpSettings() {
  const t = useTranslations('Settings.mcp');
  const { canEditSettings, profileLoading } = useAuth();
  const [origin, setOrigin] = useState('');
  const [credenciales, setCredenciales] = useState<Credencial[]>([]);
  const [cargando, setCargando] = useState(true);
  const [nuevaOpen, setNuevaOpen] = useState(false);
  const [nombre, setNombre] = useState('');
  const [scopes, setScopes] = useState<McpScope[]>(['read']);
  const [guardando, setGuardando] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [confirmar, setConfirmar] = useState<string | null>(null);

  const editable = canEditSettings && !profileLoading;
  const url = `${origin}/api/mcp`;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/settings/mcp/credentials');
      if (!res.ok) throw new Error('load');
      const json = await res.json();
      setCredenciales((json.credentials ?? []) as Credencial[]);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t('copied'));
    } catch {
      toast.error(t('loadFailed'));
    }
  };

  const alternarScope = (scope: McpScope, activo: boolean) => {
    setScopes((prev) =>
      activo ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope),
    );
  };

  const crear = async () => {
    if (!nombre.trim() || scopes.length === 0) return;
    setGuardando(true);
    try {
      const res = await fetch('/api/settings/mcp/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nombre.trim(), scopes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          json.error === 'invalid_scopes'
            ? t('errors.invalidScopes')
            : t('errors.generic'),
        );
        return;
      }
      setNuevaOpen(false);
      setNombre('');
      setScopes(['read']);
      setToken(json.token as string);
      await cargar();
    } finally {
      setGuardando(false);
    }
  };

  const revocar = async (id: string) => {
    const res = await fetch(`/api/settings/mcp/credentials/${id}`, {
      method: 'DELETE',
    });
    setConfirmar(null);
    if (!res.ok) {
      toast.error(t('errors.generic'));
      return;
    }
    toast.success(t('revokedToast'));
    await cargar();
  };

  const instrucciones = useMemo(() => {
    const code = `claude mcp add --transport http wacrm ${url} \\\n  --header "Authorization: Bearer <TU_TOKEN>"`;
    const desktop = JSON.stringify(
      {
        mcpServers: {
          wacrm: {
            command: 'npx',
            args: [
              '-y',
              'mcp-remote',
              url,
              '--header',
              'Authorization: Bearer <TU_TOKEN>',
            ],
          },
        },
      },
      null,
      2,
    );
    return { code, desktop };
  }, [url]);

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card className="overflow-hidden border-indigo-500/30 bg-[#0b1020] text-slate-100 shadow-[0_18px_50px_-24px_rgba(79,70,229,0.6)]">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
              <Server className="size-4" />
            </span>
            <h2 className="text-sm font-semibold">{t('serverTitle')}</h2>
            <Badge
              variant="outline"
              className="border-emerald-400/40 text-emerald-300"
            >
              {t('online')}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('serverDesc')}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-indigo-400/20 bg-black/40 px-3 py-2 font-mono text-[12px] text-indigo-200">
              {url}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copiar(url)}
            >
              <Copy className="size-3.5" />
              {t('copy')}
            </Button>
          </div>

          <pre className="mt-2 overflow-x-auto rounded-lg border border-indigo-400/20 bg-black/40 p-3 font-mono text-[11.5px] text-slate-300">
{`Authorization: Bearer mcp_live_…`}
          </pre>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-indigo-400/30 bg-indigo-500/10 text-indigo-100 hover:bg-indigo-500/20"
              onClick={() => setHowToOpen(true)}
            >
              <Terminal className="size-3.5" />
              {t('howTo')}
            </Button>
            <span className="text-[11px] text-slate-500">{t('serverHint')}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <BrainCircuit className="size-4 text-primary" />
              {t('credentialsTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('credentialsDesc')}
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setNombre('');
              setScopes(['read']);
              setNuevaOpen(true);
            }}
            disabled={!editable}
          >
            <Plus className="size-4" />
            {t('newCredential')}
          </Button>
        </CardHeader>
        <CardContent>
          {cargando ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('loading')}
            </div>
          ) : credenciales.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <span className="bg-muted flex size-12 items-center justify-center rounded-full">
                <BrainCircuit className="text-muted-foreground size-6" />
              </span>
              <p className="text-sm font-medium text-foreground">
                {t('emptyTitle')}
              </p>
              <p className="text-muted-foreground max-w-sm text-xs">
                {t('emptyDesc')}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setNuevaOpen(true)}
                disabled={!editable}
              >
                <Plus className="size-4" />
                {t('newCredential')}
              </Button>
            </div>
          ) : (
            <ul className="divide-border divide-y">
              {credenciales.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-foreground truncate text-sm font-medium">
                        {c.name}
                      </p>
                      {c.revoked_at ? (
                        <Badge variant="destructive">{t('revoked')}</Badge>
                      ) : (
                        <Badge variant="secondary">{t('active')}</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground truncate font-mono text-[11px]">
                      {c.key_prefix}…
                    </p>
                    <p className="text-muted-foreground text-[11px]">
                      {t('lastUsed')}: {formatearFecha(c.last_used_at, t('never'))}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="text-[10px]">
                          {t(`scopes.${s}`)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {!c.revoked_at &&
                    (confirmar === c.id ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground text-[11px]">
                          {t('confirmRevoke')}
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void revocar(c.id)}
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setConfirmar(c.id)}
                        disabled={!editable}
                      >
                        <Trash2 className="size-3.5" />
                        {t('revoke')}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={nuevaOpen} onOpenChange={setNuevaOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('newCredential')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('newCredentialDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('name')}
              </Label>
              <Input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="bg-muted"
                placeholder="Claude Desktop"
              />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">
                {t('scopesTitle')}
              </Label>
              <div className="flex flex-col gap-2">
                {MCP_SCOPES.map((s) => (
                  <label
                    key={s}
                    className="border-border flex cursor-pointer items-start gap-2 rounded-lg border p-2.5"
                  >
                    <Checkbox
                      checked={scopes.includes(s)}
                      onCheckedChange={(v) => alternarScope(s, v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="text-foreground block text-xs font-medium">
                        {t(`scopes.${s}`)}
                      </span>
                      <span className="text-muted-foreground block text-[10.5px] leading-snug">
                        {t(`scopes.${s}Help`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNuevaOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void crear()}
              disabled={guardando || !nombre.trim() || scopes.length === 0}
            >
              {guardando && <Loader2 className="size-4 animate-spin" />}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={token !== null}
        onOpenChange={(open) => {
          if (!open) setToken(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="size-4 text-emerald-500" />
              {t('createdTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('createdDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="border-border bg-muted/40 flex items-center gap-2 rounded-lg border p-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px]">
              {token}
            </code>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => token && void copiar(token)}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
          <p className="text-destructive text-[11px]">{t('tokenWarning')}</p>
          <DialogFooter>
            <Button onClick={() => setToken(null)}>{t('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={howToOpen} onOpenChange={setHowToOpen}>
        <DialogContent className="border-border bg-popover max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('howTo')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('howToDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <Bloque
              icon={<Terminal className="size-3.5" />}
              titulo={t('claudeCodeTitle')}
              texto={instrucciones.code}
              onCopy={() => void copiar(instrucciones.code)}
              copyLabel={t('copy')}
            />
            <Bloque
              icon={<Monitor className="size-3.5" />}
              titulo={t('claudeDesktopTitle')}
              texto={instrucciones.desktop}
              onCopy={() => void copiar(instrucciones.desktop)}
              copyLabel={t('copy')}
            />
            <div className="border-border bg-card rounded-lg border p-3">
              <p className="text-foreground flex items-center gap-2 text-xs font-medium">
                <Globe className="size-3.5" />
                {t('claudeAiTitle')}
              </p>
              <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                {t('claudeAiBody', { url })}
              </p>
              <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                {t('claudeAiNote')}
              </p>
            </div>
            <p className="text-muted-foreground text-[11px]">
              {t('howToNote')}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setHowToOpen(false)}>{t('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Bloque({
  icon,
  titulo,
  texto,
  onCopy,
  copyLabel,
}: {
  icon: React.ReactNode;
  titulo: string;
  texto: string;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-foreground flex items-center gap-2 text-xs font-medium">
          {icon}
          {titulo}
        </p>
        <Button size="sm" variant="ghost" onClick={onCopy}>
          <Copy className="size-3.5" />
          {copyLabel}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-black/40 p-2.5 font-mono text-[11px] text-slate-200">
        {texto}
      </pre>
    </div>
  );
}
