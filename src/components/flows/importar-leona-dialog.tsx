'use client';

/**
 * «Importar flujo(s)», como el de Leona: se pegan uno o varios códigos
 * (separados por coma o en líneas distintas) y el WaCRM trae cada flujo
 * completo de Leona —bloques, textos, archivos, posiciones y líneas— como
 * borrador. También se pueden elegir de la lista de flujos de tu Leona o
 * subir un archivo .json (del WaCRM o de Leona).
 */

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Download, FileJson, Loader2, ListChecks } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface FlujoLeona {
  id: string;
  uuid: string;
  name: string;
  status: string;
}

interface Resultado {
  created: Array<{ id: string; name: string; nodos: number; avisos: string[] }>;
  errors: Array<{ code: string; error: string }>;
}

export function ImportarLeonaDialog({
  open,
  onOpenChange,
  onImportado,
  onArchivo,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Se llama con el id del primer flujo creado. */
  onImportado: (id: string) => void;
  /** «Subir archivo .json». */
  onArchivo: () => void;
}) {
  const [codigos, setCodigos] = useState('');
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [lista, setLista] = useState<FlujoLeona[] | null>(null);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [sinCredencial, setSinCredencial] = useState(false);

  const cerrar = (v: boolean) => {
    if (!v) {
      setResultado(null);
      setCodigos('');
    }
    onOpenChange(v);
  };

  const verLista = async () => {
    setCargandoLista(true);
    try {
      const res = await fetch('/api/flows/import-leona');
      const json = await res.json().catch(() => ({}));
      if (json.error === 'leona_not_configured') {
        setSinCredencial(true);
        return;
      }
      if (!res.ok) {
        toast.error(json.detail ?? 'No se pudo leer tu Leona.');
        return;
      }
      setLista(json.flows ?? []);
    } finally {
      setCargandoLista(false);
    }
  };

  const agregar = (f: FlujoLeona) => {
    const c = f.uuid || f.id;
    setCodigos((prev) => (prev.split(/[\s,;]+/).includes(c) ? prev : prev.trim() ? `${prev.trim()}\n${c}` : c));
  };

  const importar = async () => {
    setImportando(true);
    setResultado(null);
    try {
      const res = await fetch('/api/flows/import-leona', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codes: codigos }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.error === 'leona_not_configured') {
        setSinCredencial(true);
        return;
      }
      if (json.error === 'no_codes') {
        toast.error('Pega al menos un código de flujo de Leona.');
        return;
      }
      if (json.error && !json.created) {
        toast.error(json.detail ?? 'No se pudo importar.');
        return;
      }
      setResultado(json as Resultado);
      const n = (json as Resultado).created?.length ?? 0;
      if (n > 0) toast.success(n === 1 ? 'Flujo importado.' : `${n} flujos importados.`);
    } finally {
      setImportando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={cerrar}>
      <DialogContent className="border-[#251e45] bg-[#110e20] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-50">
            <Download className="h-4 w-4 text-[#8b5cf6]" />
            Importar flujo(s)
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Ingresa el o los códigos del flujo de Leona que deseas importar. Puedes importar varios
            separando los códigos por coma o salto de línea.
          </DialogDescription>
        </DialogHeader>

        {sinCredencial ? (
          <div className="rounded-[7.5px] border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] text-amber-200">
            Primero conecta tu Leona en{' '}
            <Link href="/settings?tab=integrations" className="font-semibold underline">
              Configuración → Integraciones → Leona
            </Link>{' '}
            (token estático de Herramientas MCP).
          </div>
        ) : resultado ? (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {resultado.created.map((c) => (
              <div key={c.id} className="rounded-[7.5px] border border-[#251e45] bg-[#1c1734] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[13px] font-semibold text-slate-50">{c.name}</p>
                  <button
                    type="button"
                    onClick={() => onImportado(c.id)}
                    className="shrink-0 text-[12px] font-medium text-[#a78bfa] hover:underline"
                  >
                    Abrir →
                  </button>
                </div>
                <p className="text-[11px] text-slate-400">{c.nodos} bloques · borrador</p>
                {c.avisos.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[11px] text-amber-200/90">
                    {c.avisos.map((a) => (
                      <li key={a}>• {a}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {resultado.errors.map((e) => (
              <p key={e.code} className="rounded-[7.5px] border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-300">
                {e.code}: {e.error}
              </p>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={codigos}
              onChange={(e) => setCodigos(e.target.value)}
              rows={5}
              placeholder={'Ingresa el o los códigos del flujo\nEjemplo: 123, 456, 789\no un código por línea'}
              className="w-full rounded-[7.5px] border border-[#362c64] bg-[#1c1734] p-3 font-mono text-[12.5px] text-slate-50 outline-none placeholder:text-slate-500 focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/30"
            />
            <p className="text-[11px] text-slate-500">
              El código es el de «Compartir» en Leona. Si el flujo es de otra cuenta, impórtalo
              primero en tu Leona y luego tráelo aquí.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void verLista()}
                disabled={cargandoLista}
                className="inline-flex h-8 items-center gap-1.5 rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-3 text-[12px] text-slate-100 hover:bg-[#2e2654]"
              >
                {cargandoLista ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                Elegir de mis flujos de Leona
              </button>
              <button
                type="button"
                onClick={onArchivo}
                className="inline-flex h-8 items-center gap-1.5 rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-3 text-[12px] text-slate-100 hover:bg-[#2e2654]"
              >
                <FileJson className="h-3.5 w-3.5" />
                Subir archivo .json
              </button>
            </div>
            {lista && (
              <div className="max-h-48 overflow-y-auto rounded-[7.5px] border border-[#251e45]">
                {lista.length === 0 && <p className="p-3 text-[12px] text-slate-400">No hay flujos en tu Leona.</p>}
                {lista.map((f) => (
                  <button
                    key={f.uuid || f.id}
                    type="button"
                    onClick={() => agregar(f)}
                    className="flex w-full items-center justify-between gap-2 border-b border-white/5 px-3 py-2 text-left text-[12.5px] text-slate-200 last:border-0 hover:bg-[#241e42]"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">{f.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => cerrar(false)}>
            {resultado ? 'Cerrar' : 'Cancelar'}
          </Button>
          {!resultado && !sinCredencial && (
            <Button
              onClick={() => void importar()}
              disabled={importando || !codigos.trim()}
              className="bg-[#8b5cf6] text-white hover:bg-[#7c3aed]"
            >
              {importando && <Loader2 className="h-4 w-4 animate-spin" />}
              Importar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
