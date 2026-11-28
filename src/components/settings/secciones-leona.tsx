'use client';

/**
 * Secciones de Configuración que copian el menú de Leona y no existían en
 * el WaCRM como panel propio: Empresa (con pestañas), Invitaciones a la
 * plataforma, Acceso de soporte, Traducciones de flujo y Uso de IA.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Building2, Clock, Headphones, Languages, Loader2, UserPlus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { DealsSettings } from './deals-settings';
import { InboxSettings } from './inbox-settings';
import { DepartmentsSettings } from './departments-settings';
import { BusinessHoursSettings } from './business-hours-settings';
import { InviteMemberDialog } from './invite-member-dialog';
import { AiUsageCard } from '@/components/agents/ai-usage';

export const TARJETA = 'rounded-[5.6px] border border-[#251e45] bg-[#1c1734]';
export const BOTON_MORADO =
  'inline-flex h-[38px] items-center gap-2 rounded-[7.5px] bg-[#8b5cf6] px-5 text-[13px] font-medium text-white transition-colors hover:bg-[#7c3aed] disabled:opacity-60';

/** Encabezado de sección, como Leona: título, descripción y acción a la derecha. */
export function CabeceraSeccion({
  titulo,
  descripcion,
  accion,
}: {
  titulo: string;
  descripcion?: string;
  accion?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-[16.9px] font-bold text-slate-50">{titulo}</h2>
        {descripcion && <p className="text-[13px] text-slate-400">{descripcion}</p>}
      </div>
      {accion}
    </div>
  );
}

function EstadoVacio({ icono: Icono, titulo, texto }: { icono: typeof Building2; titulo: string; texto: string }) {
  return (
    <div className={cn(TARJETA, 'flex flex-col items-center gap-2 px-6 py-14 text-center')}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#241e42] text-slate-400">
        <Icono className="h-5 w-5" />
      </span>
      <p className="text-[13px] font-semibold text-slate-100">{titulo}</p>
      <p className="max-w-md text-[12px] text-slate-400">{texto}</p>
    </div>
  );
}

// ------------------------------------------------------------
// Empresa
// ------------------------------------------------------------

type PestanaEmpresa = 'datos' | 'departamentos' | 'horarios';

export function EmpresaSettings() {
  const [pestana, setPestana] = useState<PestanaEmpresa>('datos');
  const pestanas: { id: PestanaEmpresa; label: string; icono: typeof Building2 }[] = [
    { id: 'datos', label: 'Datos corporativos', icono: Building2 },
    { id: 'departamentos', label: 'Departamentos', icono: Building2 },
    { id: 'horarios', label: 'Horarios de trabajo', icono: Clock },
  ];
  return (
    <div>
      <CabeceraSeccion titulo="Empresa" descripcion="Datos de la empresa seleccionada en el menú lateral." />
      <div className="mb-4 flex flex-wrap gap-2">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPestana(p.id)}
            className={cn(
              'inline-flex h-[30px] items-center gap-1.5 rounded-[5.6px] px-[13px] text-[11.25px] font-bold transition-colors',
              pestana === p.id ? 'bg-[#8b5cf6] text-white' : 'bg-[#241e42] text-slate-300 hover:text-white',
            )}
          >
            <p.icono className="h-3.5 w-3.5" />
            {p.label}
          </button>
        ))}
      </div>
      {pestana === 'datos' && <DatosCorporativos />}
      {pestana === 'departamentos' && <DepartmentsSettings />}
      {pestana === 'horarios' && <BusinessHoursSettings />}
    </div>
  );
}

function DatosCorporativos() {
  const { account } = useAuth();
  const [nombre, setNombre] = useState('');
  const [guardando, setGuardando] = useState(false);
  useEffect(() => {
    if (account?.name) setNombre(account.name);
  }, [account?.name]);

  const guardar = async () => {
    if (!nombre.trim()) return;
    setGuardando(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nombre.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'No se pudo guardar.');
        return;
      }
      toast.success('Empresa guardada.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className={cn(TARJETA, 'p-5')}>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-50">Datos de la empresa</h3>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            Activa
          </span>
        </div>
        <p className="mb-3 text-[12px] text-slate-400">Información mostrada a sus clientes y en informes</p>
        <label className="mb-1 block text-[12px] text-slate-300">Nombre de la empresa*</label>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          maxLength={80}
          className="h-[38px] w-full max-w-md rounded-[5.6px] border border-[#251e45] bg-[#110e20] px-3 text-[13px] text-slate-50 outline-none focus:border-[#8b5cf6]"
        />
        <div className="mt-4">
          <button type="button" onClick={() => void guardar()} disabled={guardando} className={BOTON_MORADO}>
            {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar empresa
          </button>
        </div>
      </section>
      <DealsSettings />
      <InboxSettings />
    </div>
  );
}

// ------------------------------------------------------------
// Invitaciones a la plataforma
// ------------------------------------------------------------

interface Invitacion {
  id: string;
  role: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export function InvitacionesSettings() {
  const [lista, setLista] = useState<Invitacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState(false);
  const [filtro, setFiltro] = useState<'todas' | 'pendientes' | 'aceptadas' | 'vencidas'>('todas');

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch('/api/account/invitations?all=1', { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as { invitations?: Invitacion[] };
      if (res.ok) setLista(json.invitations ?? []);
    } finally {
      setCargando(false);
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const ahora = Date.now();
  const estado = (i: Invitacion) =>
    i.accepted_at ? 'aceptadas' : new Date(i.expires_at).getTime() < ahora ? 'vencidas' : 'pendientes';
  const cuenta = (e: string) => lista.filter((i) => estado(i) === e).length;
  const visibles = lista.filter((i) => filtro === 'todas' || estado(i) === filtro);

  return (
    <div>
      <CabeceraSeccion
        titulo="Invitaciones a la plataforma"
        descripcion="Invita personas a tu WaCRM y sigue en qué quedó cada invitación."
        accion={
          <button type="button" onClick={() => setAbierto(true)} className={BOTON_MORADO}>
            <UserPlus className="h-4 w-4" />
            Invitar a la plataforma
          </button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Total', lista.length],
          ['Pendientes', cuenta('pendientes')],
          ['Aceptadas', cuenta('aceptadas')],
          ['Vencidas', cuenta('vencidas')],
        ].map(([l, v]) => (
          <div key={String(l)} className={cn(TARJETA, 'p-4')}>
            <p className="text-[22px] font-bold text-slate-50">{v}</p>
            <p className="text-[11px] text-slate-400">{l}</p>
          </div>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {(['todas', 'pendientes', 'aceptadas', 'vencidas'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFiltro(f)}
            className={cn(
              'h-7 rounded-[7.5px] border px-3 text-[11.25px] font-semibold capitalize',
              filtro === f ? 'border-[#8b5cf6] bg-[#8b5cf6] text-white' : 'border-[#251e45] bg-[#1c1734] text-slate-300',
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {cargando ? (
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      ) : visibles.length === 0 ? (
        <EstadoVacio
          icono={UserPlus}
          titulo="No hay invitaciones enviadas"
          texto="Invita a la primera persona con el botón de arriba."
        />
      ) : (
        <div className={cn(TARJETA, 'divide-y divide-white/10')}>
          {visibles.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
              <span className="text-slate-100">{i.label || 'Invitación'} · {i.role}</span>
              <span className="text-[11px] capitalize text-slate-400">{estado(i)}</span>
            </div>
          ))}
        </div>
      )}
      <InviteMemberDialog open={abierto} onOpenChange={setAbierto} onCreated={() => void cargar()} />
    </div>
  );
}

// ------------------------------------------------------------
// Acceso de soporte · Traducciones de flujo · Uso de IA
// ------------------------------------------------------------

export function SoporteSettings() {
  return (
    <div>
      <CabeceraSeccion
        titulo="Acceso de soporte"
        descripcion="Equipo de soporte con acceso temporal aprobado en esta cuenta."
      />
      <EstadoVacio
        icono={Headphones}
        titulo="Ningún soporte con acceso activo."
        texto="En el WaCRM nadie de soporte entra a tu cuenta: solo tu equipo, desde Equipo."
      />
    </div>
  );
}

export function TraduccionesSettings() {
  return (
    <div>
      <CabeceraSeccion
        titulo="Traducciones de flujo"
        descripcion="Historial de flujos traducidos a otro idioma."
      />
      <EstadoVacio
        icono={Languages}
        titulo="No hay traducciones en esta cuenta."
        texto="Traducir un flujo completo con IA todavía no está disponible en el WaCRM."
      />
    </div>
  );
}

export function UsoIaSettings() {
  return (
    <div>
      <CabeceraSeccion
        titulo="Uso de IA"
        descripcion="Las conversaciones atendidas por la IA, con lo que se usó en cada una."
      />
      <AiUsageCard />
    </div>
  );
}
