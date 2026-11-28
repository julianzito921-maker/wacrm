'use client';

/**
 * Configuración → Flujos estándar, igual que Leona: por cada número,
 * Bienvenida · Conversación finalizada · Respuesta predeterminada (con
 * horas) · Atención finalizada y Palabras clave (tienen prioridad).
 * «Selección masiva» guarda la misma configuración en varios números.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Info, Loader2, Plus, Save, Search, SquareCheckBig, Trash2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FlujosEstandar, OperadorPalabra, PalabraClave } from '@/lib/flows/estandar';

interface Conexion {
  id: string;
  name: string;
  phone_number: string | null;
  status: string;
  standard_flows: FlujosEstandar;
}
interface Flujo {
  id: string;
  name: string;
  status: string;
}

const CASILLAS = [
  { campo: 'welcome_flow_id', label: 'Bienvenida', ayuda: 'Se activa para contactos nuevos en el primer mensaje' },
  {
    campo: 'reopened_flow_id',
    label: 'Conversación finalizada',
    ayuda: 'Se activa cuando el cliente reabre una conversación ya marcada como completada',
  },
  {
    campo: 'default_reply_flow_id',
    label: 'Respuesta predeterminada',
    ayuda: 'Se activa cuando no hay palabra clave coincidente, tras un periodo de inactividad',
  },
  {
    campo: 'attendance_finished_flow_id',
    label: 'Atención finalizada',
    ayuda: 'Se activa cuando la atención se marca como completada',
  },
] as const;
type Campo = (typeof CASILLAS)[number]['campo'];

const OPERADORES: { id: OperadorPalabra; label: string }[] = [
  { id: 'equals', label: 'Es igual' },
  { id: 'contains', label: 'Contiene' },
  { id: 'not_equals', label: 'Es distinto' },
  { id: 'not_contains', label: 'No contiene' },
  { id: 'starts_with', label: 'Empieza con' },
  { id: 'ends_with', label: 'Termina con' },
];

const CAMPO =
  'h-[38px] w-full rounded-[5.6px] border border-[#251e45] bg-[#1c1734] px-3 text-[13px] font-semibold text-slate-50 outline-none focus:border-[#8b5cf6]';

function completas(cfg: FlujosEstandar) {
  return CASILLAS.filter((c) => cfg[c.campo]).length;
}

export function FlujosEstandarSettings() {
  const [conexiones, setConexiones] = useState<Conexion[]>([]);
  const [flujos, setFlujos] = useState<Flujo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<'todas' | 'incompletas' | 'sin'>('todas');
  const [masiva, setMasiva] = useState(false);
  const [elegidas, setElegidas] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [rc, rf] = await Promise.all([fetch('/api/settings/flujos-estandar'), fetch('/api/flows')]);
      const jc = (await rc.json().catch(() => ({}))) as { connections?: Conexion[] };
      const jf = (await rf.json().catch(() => ({}))) as { flows?: Flujo[] };
      setConexiones(jc.connections ?? []);
      setFlujos((jf.flows ?? []).filter((f) => f.status !== 'archived'));
    } finally {
      setCargando(false);
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const estado = (c: Conexion) => {
    const n = completas(c.standard_flows);
    return n === CASILLAS.length ? 'completo' : n === 0 && !(c.standard_flows.keywords ?? []).length ? 'sin' : 'incompleto';
  };
  const q = busqueda.trim().toLowerCase();
  const visibles = conexiones
    .filter((c) => !q || `${c.name} ${c.phone_number ?? ''}`.toLowerCase().includes(q))
    .filter((c) => (filtro === 'todas' ? true : filtro === 'sin' ? estado(c) === 'sin' : estado(c) === 'incompleto'));

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-[18.75px] font-bold text-slate-50">Flujos estándar</h2>
        <p className="text-[13px] text-[#a78bfa]">Defina los flujos estándar de cada conexión de WhatsApp.</p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar conexión..."
            className="h-[38px] w-full rounded-[5.6px] border border-[#251e45] bg-[#1c1734] pr-3 pl-9 text-[13px] text-slate-50 outline-none placeholder:text-slate-500 focus:border-[#8b5cf6]"
          />
        </div>
        <div className="flex rounded-[7.5px] border border-[#251e45] bg-[#1c1734] p-1">
          {(
            [
              ['todas', 'Todas', conexiones.length],
              ['incompletas', 'Incompletas', conexiones.filter((c) => estado(c) === 'incompleto').length],
              ['sin', 'Sin flujos', conexiones.filter((c) => estado(c) === 'sin').length],
            ] as const
          ).map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFiltro(id)}
              className={cn(
                'h-[30px] rounded-[5.6px] px-3 text-[13px] font-medium',
                filtro === id ? 'bg-[#2e2654] text-white' : 'text-slate-400 hover:text-white',
              )}
            >
              {label} <span className="ml-1 opacity-70">{n}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setMasiva((v) => !v);
            setElegidas([]);
          }}
          className={cn(
            'inline-flex h-[38px] items-center gap-2 rounded-[7.5px] border px-3 text-[13px] font-medium',
            masiva ? 'border-[#8b5cf6] bg-[#8b5cf6]/20 text-white' : 'border-[#251e45] bg-[#1c1734] text-slate-100',
          )}
        >
          <SquareCheckBig className="h-4 w-4" />
          Selección masiva
        </button>
      </div>

      {masiva && (
        <p className="mb-3 rounded-[5.6px] border border-[#8b5cf6]/40 bg-[#8b5cf6]/10 px-3 py-2 text-[12px] text-slate-200">
          Marca las conexiones y guarda en cualquiera: la misma configuración se aplica a todas las marcadas
          ({elegidas.length}).
        </p>
      )}

      {cargando ? (
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      ) : visibles.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-slate-400">No hay conexiones en este filtro.</p>
      ) : (
        <div className="space-y-3">
          {visibles.map((c, i) => (
            <TarjetaConexion
              // La clave incluye lo guardado: al recargar, la tarjeta arranca limpia.
              key={`${c.id}:${JSON.stringify(c.standard_flows)}`}
              conexion={c}
              flujos={flujos}
              abiertaInicial={i === 0}
              masiva={masiva}
              marcada={elegidas.includes(c.id)}
              onMarcar={(v) => setElegidas((prev) => (v ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
              destinos={masiva && elegidas.length ? [...new Set([c.id, ...elegidas])] : [c.id]}
              onGuardado={() => void cargar()}
            />
          ))}
        </div>
      )}
      <p className="mt-6 text-center text-[12px] text-[#a78bfa]">
        ¿Necesitas aplicar el mismo flujo en varias? Activa &apos;Selección masiva&apos;.
      </p>
    </div>
  );
}

function TarjetaConexion({
  conexion,
  flujos,
  abiertaInicial,
  masiva,
  marcada,
  onMarcar,
  destinos,
  onGuardado,
}: {
  conexion: Conexion;
  flujos: Flujo[];
  abiertaInicial: boolean;
  masiva: boolean;
  marcada: boolean;
  onMarcar: (v: boolean) => void;
  destinos: string[];
  onGuardado: () => void;
}) {
  const [abierta, setAbierta] = useState(abiertaInicial);
  const [cfg, setCfg] = useState<FlujosEstandar>(conexion.standard_flows);
  const [guardando, setGuardando] = useState(false);
  const [palabrasAbiertas, setPalabrasAbiertas] = useState(false);

  const sucio = useMemo(() => JSON.stringify(cfg) !== JSON.stringify(conexion.standard_flows), [cfg, conexion]);
  const n = completas(cfg);
  const nombreFlujo = (id?: string | null) => flujos.find((f) => f.id === id)?.name ?? '—';

  const guardar = async () => {
    setGuardando(true);
    try {
      const res = await fetch('/api/settings/flujos-estandar', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connection_ids: destinos, standard_flows: cfg }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error === 'invalid_flow' ? 'Uno de los flujos no es de esta cuenta.' : 'No se pudo guardar.');
        return;
      }
      toast.success(destinos.length > 1 ? `Guardado en ${destinos.length} conexiones.` : 'Flujos estándar guardados.');
      onGuardado();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-[7.5px] border border-[#362c64] bg-[#161229]">
      <div className="flex items-center gap-3 bg-[#1c1734] px-4 py-3">
        {masiva && (
          <input
            type="checkbox"
            checked={marcada}
            onChange={(e) => onMarcar(e.target.checked)}
            className="h-4 w-4 accent-[#8b5cf6]"
            aria-label={`Marcar ${conexion.name}`}
          />
        )}
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[7.5px] bg-[#2e2654] text-[13px] font-bold text-[#c4b5fd]">
          {conexion.name.slice(0, 1).toUpperCase()}
          <span
            className={cn(
              'absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#1c1734]',
              conexion.status === 'connected' ? 'bg-emerald-400' : 'bg-slate-500',
            )}
          />
        </span>
        <button type="button" onClick={() => setAbierta((v) => !v)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-[14px] font-semibold text-slate-50">{conexion.name}</p>
          <p className="font-mono text-[11.5px] text-slate-400">{conexion.phone_number ?? '—'}</p>
        </button>
        <div className="hidden gap-1 sm:flex" aria-label={`${n} de ${CASILLAS.length}`}>
          {CASILLAS.map((c) => (
            <span key={c.campo} className={cn('h-[3px] w-4 rounded-full', cfg[c.campo] ? 'bg-[#8b5cf6]' : 'bg-[#362c64]')} />
          ))}
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-semibold',
            n === CASILLAS.length
              ? 'bg-emerald-500/15 text-emerald-300'
              : n === 0
                ? 'bg-slate-500/20 text-slate-300'
                : 'bg-amber-500/15 text-amber-300',
          )}
        >
          {n === CASILLAS.length ? 'Completo' : n === 0 ? 'Sin flujos' : 'Incompleto'}
        </span>
        <button type="button" onClick={() => setAbierta((v) => !v)} className="text-slate-300" aria-label="Abrir">
          {abierta ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {abierta && (
        <div className="space-y-4 px-4 py-4">
          <div className="grid gap-x-3 gap-y-4 md:grid-cols-2">
            {[CASILLAS[0], CASILLAS[1], CASILLAS[2], CASILLAS[3]].map((c) => (
              <label key={c.campo} className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-slate-200">
                  {c.label}
                  <Info className="h-3.5 w-3.5 text-slate-400" aria-label={c.ayuda}>
                    <title>{c.ayuda}</title>
                  </Info>
                </span>
                <div className="flex gap-2">
                  <SelectorFlujo
                    valor={cfg[c.campo as Campo] ?? null}
                    flujos={flujos}
                    onCambio={(v) => setCfg({ ...cfg, [c.campo]: v })}
                  />
                  {c.campo === 'default_reply_flow_id' && (
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={720}
                        aria-label="Retraso (h)"
                        value={cfg.default_reply_hours ?? 24}
                        onChange={(e) => setCfg({ ...cfg, default_reply_hours: Math.max(0, Number(e.target.value) || 0) })}
                        className="h-[38px] w-[52px] rounded-[5.6px] border border-[#251e45] bg-[#1c1734] px-2 text-center text-[13px] font-semibold text-slate-50 outline-none focus:border-[#8b5cf6]"
                      />
                      <span className="text-[12px] text-[#a78bfa]">h</span>
                    </span>
                  )}
                </div>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-[#251e45] pt-3">
            <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Palabras clave</span>
            {(cfg.keywords ?? []).map((k, i) => (
              <span key={i} className="rounded-[5.6px] bg-[#2e2654] px-2 py-1 text-[12px] text-slate-100">
                {k.conditions[0]?.value} → {nombreFlujo(k.flow_id)}
              </span>
            ))}
            <button
              type="button"
              onClick={() => setPalabrasAbiertas(true)}
              className="rounded-[5.6px] border border-dashed border-[#362c64] px-2 py-1 text-[12px] text-slate-300 hover:text-white"
            >
              + añadir
            </button>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={!sucio || guardando}
              onClick={() => setCfg(conexion.standard_flows)}
              className="h-[34px] rounded-[7.5px] border border-[#251e45] bg-[#1c1734] px-4 text-[13px] font-medium text-slate-100 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={(!sucio && destinos.length < 2) || guardando}
              onClick={() => void guardar()}
              className="inline-flex h-[34px] items-center gap-2 rounded-[7.5px] bg-[#8b5cf6] px-4 text-[13px] font-medium text-white hover:bg-[#7c3aed] disabled:opacity-50"
            >
              {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar
            </button>
          </div>
        </div>
      )}

      {palabrasAbiertas && (
      <DialogoPalabras
        abierto={palabrasAbiertas}
        onCerrar={() => setPalabrasAbiertas(false)}
        flujos={flujos}
        inicial={cfg.keywords ?? []}
        onListo={(keywords) => {
          setCfg({ ...cfg, keywords });
          setPalabrasAbiertas(false);
        }}
      />
      )}
    </div>
  );
}

function SelectorFlujo({
  valor,
  flujos,
  onCambio,
}: {
  valor: string | null;
  flujos: Flujo[];
  onCambio: (v: string | null) => void;
}) {
  return (
    <div className="relative flex-1">
      <select
        value={valor ?? ''}
        onChange={(e) => onCambio(e.target.value || null)}
        className={cn(CAMPO, 'appearance-none pr-14')}
      >
        <option value="">Sin flujo</option>
        {flujos.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {f.status !== 'active' ? ' (pausado)' : ''}
          </option>
        ))}
      </select>
      {valor && (
        <button
          type="button"
          onClick={() => onCambio(null)}
          aria-label="Quitar flujo"
          className="absolute top-1/2 right-8 -translate-y-1/2 text-slate-400 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

function DialogoPalabras({
  abierto,
  onCerrar,
  flujos,
  inicial,
  onListo,
}: {
  abierto: boolean;
  onCerrar: () => void;
  flujos: Flujo[];
  inicial: PalabraClave[];
  onListo: (k: PalabraClave[]) => void;
}) {
  const vacia = (): PalabraClave => ({ flow_id: '', conditions: [{ operator: 'contains', value: '' }] });
  // Se monta al abrir, así arranca siempre con lo guardado.
  const [lista, setLista] = useState<PalabraClave[]>(inicial.length ? inicial : [vacia()]);

  const cambiar = (i: number, k: PalabraClave) => setLista((l) => l.map((x, j) => (j === i ? k : x)));

  return (
    <Dialog open={abierto} onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="border-[#251e45] bg-[#110e20] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-slate-50">Palabras clave</DialogTitle>
          <DialogDescription className="text-slate-400">
            Tienen prioridad sobre los demás flujos estándar
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto">
          {lista.map((k, i) => (
            <div key={i} className="space-y-2 rounded-[7.5px] border border-[#251e45] bg-[#161229] p-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-slate-200">Palabra clave {i + 1}</span>
                <button
                  type="button"
                  aria-label="Eliminar palabra clave"
                  onClick={() => setLista((l) => l.filter((_, j) => j !== i))}
                  className="text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <SelectorFlujo
                valor={k.flow_id || null}
                flujos={flujos}
                onCambio={(v) => cambiar(i, { ...k, flow_id: v ?? '' })}
              />
              {k.conditions.map((c, j) => (
                <div key={j} className="flex gap-2">
                  <select
                    value={c.operator}
                    onChange={(e) =>
                      cambiar(i, {
                        ...k,
                        conditions: k.conditions.map((x, m) => (m === j ? { ...x, operator: e.target.value as OperadorPalabra } : x)),
                      })
                    }
                    className={cn(CAMPO, 'w-[140px] shrink-0 font-medium')}
                  >
                    {OPERADORES.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={c.value}
                    placeholder="Palabra clave"
                    onChange={(e) =>
                      cambiar(i, {
                        ...k,
                        conditions: k.conditions.map((x, m) => (m === j ? { ...x, value: e.target.value } : x)),
                      })
                    }
                    className={cn(CAMPO, 'font-medium')}
                  />
                  {k.conditions.length > 1 && (
                    <button
                      type="button"
                      aria-label="Quitar condición"
                      onClick={() => cambiar(i, { ...k, conditions: k.conditions.filter((_, m) => m !== j) })}
                      className="text-slate-400 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => cambiar(i, { ...k, conditions: [...k.conditions, { operator: 'contains', value: '' }] })}
                className="inline-flex items-center gap-1 text-[12px] text-[#a78bfa] hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Añadir condición
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLista((l) => [...l, vacia()])}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-[7.5px] border border-[#251e45] bg-[#241e42] px-3 text-[13px] text-slate-100"
          >
            <Plus className="h-4 w-4" /> Agregar palabra clave
          </button>
        </div>
        <DialogFooter>
          <button type="button" onClick={onCerrar} className="h-[34px] rounded-[7.5px] px-4 text-[13px] text-slate-300 hover:bg-[#241e42]">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() =>
              onListo(
                lista
                  .map((k) => ({ ...k, conditions: k.conditions.filter((c) => c.value.trim()) }))
                  .filter((k) => k.flow_id && k.conditions.length),
              )
            }
            className="h-[34px] rounded-[7.5px] bg-[#8b5cf6] px-4 text-[13px] font-medium text-white hover:bg-[#7c3aed]"
          >
            Listo
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
