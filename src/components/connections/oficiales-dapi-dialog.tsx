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
            Conecta tus números oficiales de WhatsApp. Se crean en D-API (Embedded Signup o
            Coexistencia) y aquí los traes al WaCRM, uno por uno.
          </DialogDescription>
        </DialogHeader>

        {sinClave ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] text-amber-200">
            Primero guarda tu API Key secreta de D-API en{' '}
            <Link href="/settings?tab=integrations" className="font-semibold underline">
              Configuración → Integraciones → D-API
            </Link>
            .
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
