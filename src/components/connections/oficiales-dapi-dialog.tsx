'use client';

/**
 * «API Oficial (D-API)»: los números oficiales (WhatsApp Cloud API) que
 * conectaste en el panel de D-API, para traerlos al WaCRM uno por uno.
 * Al conectar, el WaCRM crea la isla y apunta el webhook de ese número a
 * su URL secreta: desde ahí todo entra por flujos, IA, inbox y ventas.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { BadgeCheck, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Sesion {
  sessionId: string;
  nombre: string;
  telefono: string;
  estado: string;
  connection_id: string | null;
}

export function OficialesDapiDialog({
  open,
  onOpenChange,
  onConectado,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConectado: () => void;
}) {
  const [cargando, setCargando] = useState(false);
  const [sesiones, setSesiones] = useState<Sesion[]>([]);
  const [sinClave, setSinClave] = useState(false);
  const [conectando, setConectando] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', instanceId: '', apiKey: '' });
  const [enviando, setEnviando] = useState(false);

  const finalizar = async () => {
    setEnviando(true);
    try {
      const res = await fetch('/api/connections/dapi/instancia', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg: Record<string, string> = {
          invalid_instance: 'Revisa el Instance ID.',
          invalid_api_key: 'La API Key no es válida para esa instancia.',
          instance_not_found: 'D-API no encontró esa instancia.',
          already_connected: 'Esa instancia ya está conectada.',
          duplicate_phone: 'Esa instancia ya está conectada en otra cuenta.',
        };
        toast.error(msg[json.error] ?? (json.detail ? `D-API: ${json.detail}` : 'No se pudo conectar.'));
        return;
      }
      toast.success('¡Instancia conectada! Los mensajes ya entran al WaCRM.');
      setForm({ name: '', instanceId: '', apiKey: '' });
      onConectado();
      onOpenChange(false);
    } finally {
      setEnviando(false);
    }
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/connections/dapi/oficiales');
      const json = await res.json().catch(() => ({}));
      if (json.error === 'dapi_not_configured') {
        setSinClave(true);
        return;
      }
      setSinClave(false);
      if (!res.ok) {
        toast.error(json.detail ? `D-API: ${json.detail}` : 'No se pudo leer D-API.');
        return;
      }
      setSesiones(json.sessions ?? []);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (open) void cargar();
  }, [open, cargar]);

  const conectar = async (s: Sesion) => {
    setConectando(s.sessionId);
    try {
      const res = await fetch('/api/connections/dapi/oficiales', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          json.error === 'already_connected'
            ? 'Ese número ya está conectado.'
            : json.error === 'duplicate_phone'
              ? 'Ese número ya está conectado en otra cuenta.'
              : json.detail
                ? `D-API: ${json.detail}`
                : 'No se pudo conectar.',
        );
        return;
      }
      toast.success('¡Número oficial conectado al WaCRM!');
      onConectado();
      await cargar();
    } finally {
      setConectando(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeCheck className="h-4 w-4 text-emerald-400" />
            API Oficial (D-API)
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Conecta tus números de D-API (oficiales o de QR), uno por uno. Desde ahí todo entra al
            WaCRM: contactos, inbox, flujos e IA.
          </DialogDescription>
        </DialogHeader>

        {/* Como en el tutorial de D-API: Instance ID + API Key de la instancia. */}
        <div className="border-border space-y-2 rounded-lg border p-3">
          <p className="text-[12px] text-muted-foreground">
            En D-API: Instâncias → ⋮ → Configurações → <b>Desenvolvedor</b>. Copia el{' '}
            <b>Instance ID</b> y la <b>API Key</b> de la instancia y pégalos aquí.
          </p>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Nombre de la conexión (ej. Atención)"
            className="border-border bg-muted h-9 w-full rounded-md border px-3 text-sm outline-none focus:border-primary"
          />
          <input
            value={form.instanceId}
            onChange={(e) => setForm({ ...form, instanceId: e.target.value.trim() })}
            placeholder="Instance ID (ej. cloud-… o d-api-a1)"
            className="border-border bg-muted h-9 w-full rounded-md border px-3 font-mono text-xs outline-none focus:border-primary"
          />
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value.trim() })}
            placeholder="API Key de la instancia"
            autoComplete="off"
            className="border-border bg-muted h-9 w-full rounded-md border px-3 font-mono text-xs outline-none focus:border-primary"
          />
          <Button
            size="sm"
            className="w-full"
            onClick={() => void finalizar()}
            disabled={enviando || !form.instanceId || !form.apiKey}
          >
            {enviando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Finalizar
          </Button>
        </div>

        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          O elige de tus números oficiales
        </p>

        {sinClave ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] text-amber-200">
            Para ver la lista, guarda la API Key de tu cuenta de D-API en{' '}
            <Link href="/settings?tab=integrations" className="font-semibold underline">
              Configuración → Integraciones → D-API
            </Link>
            . O usa el formulario de arriba con la clave de la instancia.
          </p>
        ) : cargando ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Leyendo tus números de D-API…
          </div>
        ) : sesiones.length === 0 ? (
          <p className="text-muted-foreground py-4 text-[13px]">
            Todavía no tienes números oficiales en D-API. Créalo allá (Nova Conexão → API Oficial)
            y vuelve aquí.
          </p>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {sesiones.map((s) => (
              <div key={s.sessionId} className="border-border flex items-center gap-3 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{s.nombre || s.sessionId}</p>
                  <p className="text-muted-foreground text-xs">
                    {s.telefono ? `+${s.telefono}` : s.sessionId}
                    {s.estado ? ` · ${s.estado}` : ''}
                  </p>
                </div>
                {s.connection_id ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                    Conectado
                  </span>
                ) : (
                  <Button size="sm" onClick={() => void conectar(s)} disabled={conectando !== null}>
                    {conectando === s.sessionId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Conectar
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <a
            href="https://app.d-api.cloud/dashboard/connections"
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
          >
            Crear número en D-API <ExternalLink className="h-3 w-3" />
          </a>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void cargar()} disabled={cargando}>
              <RefreshCw className="h-3.5 w-3.5" /> Actualizar
            </Button>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
