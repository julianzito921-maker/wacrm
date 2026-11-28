'use client';

/**
 * Flujos estándar, Variables globales y Productos (menú de Leona).
 *
 * - Flujos estándar: por cada conexión de WhatsApp se elige el flujo de
 *   «Bienvenida» (primer mensaje del contacto) y el de «Respuesta por
 *   defecto» (cualquier mensaje). Se guarda en el propio flujo:
 *   `connection_id` + disparador; el flujo que tenía ese papel pasa a manual.
 * - Variables globales: valores de la cuenta que los flujos usan como
 *   {{vars.nombre}} (de Leona llegan como {global.nombre}).
 * - Productos: el catálogo de la cuenta (`product_catalog`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AtSign, Loader2, Package, Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BOTON_MORADO, CabeceraSeccion, TARJETA } from './secciones-leona';

const INPUT =
  'h-[38px] w-full rounded-[5.6px] border border-[#251e45] bg-[#110e20] px-3 text-[13px] text-slate-50 outline-none focus:border-[#8b5cf6]';

export { FlujosEstandarSettings } from './flujos-estandar';

// ------------------------------------------------------------
// Variables globales
// ------------------------------------------------------------

interface Variable {
  key: string;
  value: string;
  description: string | null;
}

export function VariablesGlobalesSettings() {
  const [lista, setLista] = useState<Variable[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');
  const [editando, setEditando] = useState<Variable | null>(null);
  const [nueva, setNueva] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/settings/variables');
      const json = (await res.json().catch(() => ({}))) as { variables?: Variable[] };
      if (res.ok) setLista(json.variables ?? []);
    } finally {
      setCargando(false);
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const guardar = async (v: Variable) => {
    const res = await fetch('/api/settings/variables', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(v),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error === 'invalid_key' ? 'Nombre inválido: solo letras, números y _.' : 'No se pudo guardar.');
      return;
    }
    setEditando(null);
    setNueva(false);
    toast.success('Variable guardada.');
    await cargar();
  };

  const borrar = async (key: string) => {
    if (!window.confirm(`¿Eliminar la variable «${key}»?`)) return;
    const res = await fetch(`/api/settings/variables?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) toast.error('No se pudo eliminar.');
    await cargar();
  };

  const q = busqueda.trim().toLowerCase();
  const visibles = lista.filter((v) => !q || `${v.key} ${v.value} ${v.description ?? ''}`.toLowerCase().includes(q));

  return (
    <div>
      <CabeceraSeccion
        titulo="Variables globales"
        descripcion="Valores de la cuenta que usas en cualquier flujo como {{vars.nombre}}."
        accion={
          <button type="button" onClick={() => setNueva(true)} className={BOTON_MORADO}>
            <Plus className="h-4 w-4" />
            Nueva variable
          </button>
        }
      />
      <Buscador valor={busqueda} onCambio={setBusqueda} />
      {(nueva || editando) && (
        <FormVariable
          inicial={editando ?? { key: '', value: '', description: '' }}
          bloqueada={Boolean(editando)}
          onCancelar={() => {
            setEditando(null);
            setNueva(false);
          }}
          onGuardar={(v) => void guardar(v)}
        />
      )}
      {cargando ? (
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      ) : visibles.length === 0 ? (
        <div className={cn(TARJETA, 'flex flex-col items-center gap-2 py-12 text-center')}>
          <AtSign className="h-6 w-6 text-slate-500" />
          <p className="text-[13px] font-semibold text-slate-100">No se encontraron variables</p>
          <p className="text-[12px] text-slate-400">Cree su primera variable para comenzar</p>
        </div>
      ) : (
        <div className={cn(TARJETA, 'divide-y divide-white/10')}>
          {visibles.map((v) => (
            <div key={v.key} className="flex items-center gap-3 px-4 py-3">
              <code className="rounded bg-[#241e42] px-1.5 py-0.5 text-[12px] text-[#c4b5fd]">{`{{vars.${v.key}}}`}</code>
              <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{v.value}</span>
              <button type="button" aria-label="Editar" onClick={() => setEditando(v)} className="text-slate-400 hover:text-white">
                <Pencil className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Eliminar" onClick={() => void borrar(v.key)} className="text-red-400 hover:text-red-300">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FormVariable({
  inicial,
  bloqueada,
  onCancelar,
  onGuardar,
}: {
  inicial: Variable;
  bloqueada: boolean;
  onCancelar: () => void;
  onGuardar: (v: Variable) => void;
}) {
  const [v, setV] = useState<Variable>(inicial);
  return (
    <div className={cn(TARJETA, 'mb-3 grid gap-3 p-4 sm:grid-cols-3')}>
      <input
        value={v.key}
        disabled={bloqueada}
        onChange={(e) => setV({ ...v, key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })}
        placeholder="nombre (ej. clabe)"
        className={INPUT}
      />
      <input value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} placeholder="Valor" className={INPUT} />
      <input
        value={v.description ?? ''}
        onChange={(e) => setV({ ...v, description: e.target.value })}
        placeholder="Descripción (opcional)"
        className={INPUT}
      />
      <div className="flex gap-2 sm:col-span-3">
        <button type="button" onClick={() => onGuardar(v)} disabled={!v.key.trim()} className={BOTON_MORADO}>
          Guardar
        </button>
        <button type="button" onClick={onCancelar} className="h-[38px] rounded-[7.5px] px-4 text-[13px] text-slate-300 hover:bg-[#241e42]">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function Buscador({ valor, onCambio }: { valor: string; onCambio: (v: string) => void }) {
  return (
    <div className="relative mb-3">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input value={valor} onChange={(e) => onCambio(e.target.value)} placeholder="Buscar" className={cn(INPUT, 'pl-9')} />
    </div>
  );
}

// ------------------------------------------------------------
// Productos
// ------------------------------------------------------------

interface Producto {
  id: string;
  nombre: string;
  precio: number | null;
  moneda: string;
  notas: string | null;
  activo: boolean;
}

export function ProductosSettings() {
  const [lista, setLista] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');
  const [form, setForm] = useState<Partial<Producto> | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/settings/products');
      const json = (await res.json().catch(() => ({}))) as { products?: Producto[] };
      if (res.ok) setLista(json.products ?? []);
    } finally {
      setCargando(false);
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const guardar = async () => {
    if (!form?.nombre?.trim()) return;
    const res = await fetch('/api/settings/products', {
      method: form.id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      toast.error('No se pudo guardar el producto.');
      return;
    }
    toast.success('Producto guardado.');
    setForm(null);
    await cargar();
  };

  const borrar = async (p: Producto) => {
    if (!window.confirm(`¿Eliminar «${p.nombre}»?`)) return;
    const res = await fetch(`/api/settings/products?id=${p.id}`, { method: 'DELETE' });
    if (!res.ok) toast.error('No se pudo eliminar.');
    await cargar();
  };

  const q = busqueda.trim().toLowerCase();
  const visibles = useMemo(() => lista.filter((p) => !q || p.nombre.toLowerCase().includes(q)), [lista, q]);

  return (
    <div>
      <CabeceraSeccion
        titulo="Productos"
        descripcion="Tus productos para usarlos en ventas, flujos y el agente de IA."
        accion={
          <button type="button" onClick={() => setForm({ moneda: 'MXN', activo: true })} className={BOTON_MORADO}>
            <Plus className="h-4 w-4" />
            Nuevo producto
          </button>
        }
      />
      <Buscador valor={busqueda} onCambio={setBusqueda} />
      {form && (
        <div className={cn(TARJETA, 'mb-3 grid gap-3 p-4 sm:grid-cols-4')}>
          <input
            value={form.nombre ?? ''}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Nombre del producto"
            className={cn(INPUT, 'sm:col-span-2')}
          />
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.precio ?? ''}
            onChange={(e) => setForm({ ...form, precio: e.target.value === '' ? null : Number(e.target.value) })}
            placeholder="Precio"
            className={INPUT}
          />
          <select value={form.moneda ?? 'MXN'} onChange={(e) => setForm({ ...form, moneda: e.target.value })} className={INPUT}>
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </select>
          <input
            value={form.notas ?? ''}
            onChange={(e) => setForm({ ...form, notas: e.target.value })}
            placeholder="Notas (opcional)"
            className={cn(INPUT, 'sm:col-span-4')}
          />
          <div className="flex gap-2 sm:col-span-4">
            <button type="button" onClick={() => void guardar()} disabled={!form.nombre?.trim()} className={BOTON_MORADO}>
              Registrar producto
            </button>
            <button type="button" onClick={() => setForm(null)} className="h-[38px] rounded-[7.5px] px-4 text-[13px] text-slate-300 hover:bg-[#241e42]">
              Cancelar
            </button>
          </div>
        </div>
      )}
      {cargando ? (
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      ) : visibles.length === 0 ? (
        <div className={cn(TARJETA, 'flex flex-col items-center gap-2 py-12 text-center')}>
          <Package className="h-6 w-6 text-slate-500" />
          <p className="text-[13px] font-semibold text-slate-100">No hay productos</p>
          <p className="text-[12px] text-slate-400">Cree el primer producto para usarlo en ventas y flujos.</p>
        </div>
      ) : (
        <div className={cn(TARJETA, 'divide-y divide-white/10')}>
          {visibles.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <Package className="h-4 w-4 text-[#8b5cf6]" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-50">{p.nombre}</span>
              <span className="text-[12px] text-slate-300">
                {p.precio === null ? '—' : `$${p.precio} ${p.moneda}`}
              </span>
              <button type="button" aria-label="Editar" onClick={() => setForm(p)} className="text-slate-400 hover:text-white">
                <Pencil className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Eliminar" onClick={() => void borrar(p)} className="text-red-400 hover:text-red-300">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
