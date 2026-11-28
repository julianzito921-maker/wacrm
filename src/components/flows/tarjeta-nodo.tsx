'use client';

/**
 * Tarjeta de bloque del lienzo, igual a la de Leona (medida 27-nov-2026):
 *
 *   ┌─ marco de 3 px con el degradado del bloque, radio 12 ───────┐
 *   │ cabecera 60 px: ◯ ícono · Título            ✎ ⧉ 🗑          │
 *   │ métricas (#15112d): Entradas · Avances · Tasa               │
 *   │ contenido: resumen o una «píldora» por salida ──────────────●│
 *   └─────────────────────────────────────────────────────────────┘
 *
 * 240 px de ancho. Conectores de 16 px grises con borde blanco: la
 * entrada a la izquierda a la altura de la cabecera y cada salida en el
 * borde derecho de su píldora. «Venta aprobada» es un círculo de 90 px.
 *
 * La tarjeta no abre nada al tocarla: se edita con el lápiz (como en
 * Leona); se copia y se borra desde su cabecera.
 */

import { Copy, Pencil, Trash2 } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { outgoingSlots } from '@/lib/flows/edges';
import {
  NODOS_FIN_DE_RAMA,
  type ConditionNodeConfig,
  type SaveReplyNodeConfig,
} from '@/lib/flows/types';
import { useFlowEditor } from './flow-editor-state';
import {
  LEONA_COLOR,
  NODE_META,
  colorDeSalida,
  degradado,
  formatearEspera,
  nodeColors,
  summarizeNode,
  type BuilderNode,
} from './shared';

export const ANCHO_TARJETA = 240;

/** Gris de Leona para conectores y líneas. */
export const GRIS_CONECTOR = '#6b7280';
const FONDO_CUERPO = '#15112d';

export interface DatosTarjeta extends Record<string, unknown> {
  node: BuilderNode;
  isEntry: boolean;
  isFlashed: boolean;
  stats?: { entradas: number; avances: number };
  onEdit?: (key: string) => void;
  /** Resumen del disparador (solo el Inicio). */
  disparador?: string;
}

/** Color del conector: gris, salvo las salidas con significado (sí/no/timeout). */
function colorConector(node: BuilderNode, salida: string): string {
  const c = colorDeSalida(node.node_type, salida);
  return c === nodeColors(node.node_type).solid ? GRIS_CONECTOR : c;
}

const estiloConector = (color: string): React.CSSProperties => ({
  width: 16,
  height: 16,
  background: color,
  border: '2px solid #fff',
  borderRadius: '50%',
  zIndex: 10,
});

function Pildora({
  node,
  salida,
  children,
  fuerte,
}: {
  node: BuilderNode;
  salida?: string;
  children: React.ReactNode;
  /** Texto principal (13 px) o secundario (11 px). */
  fuerte?: boolean;
}) {
  const c = LEONA_COLOR[node.node_type];
  return (
    <div
      className={cn(
        'relative rounded-[7.5px] border py-[7.5px] pr-[22px] pl-[11px] leading-snug',
        fuerte ? 'text-[13px] font-medium' : 'text-[11.25px] font-semibold',
      )}
      style={{
        background: `color-mix(in srgb, ${c.to} 20%, transparent)`,
        borderColor: `color-mix(in srgb, ${c.from} 30%, transparent)`,
        color: `color-mix(in srgb, ${c.from} 32%, #fff)`,
      }}
    >
      <span className="line-clamp-3 break-words">{children}</span>
      {salida && (
        <Handle
          type="source"
          id={salida}
          position={Position.Right}
          style={{
            ...estiloConector(colorConector(node, salida)),
            right: -26,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        />
      )}
    </div>
  );
}

function Metricas({
  stats,
  compacto,
}: {
  stats?: { entradas: number; avances: number };
  compacto?: boolean;
}) {
  const t = useTranslations('Flows.builder.saveReply');
  const entradas = stats?.entradas ?? 0;
  const avances = stats?.avances ?? 0;
  const tasa = entradas > 0 ? Math.round((avances / entradas) * 100) : 0;
  const celdas = [
    [t('entries'), String(entradas)],
    [t('advances'), String(avances)],
    [t('rate'), `${tasa}%`],
  ];
  return (
    <div
      className={cn('grid grid-cols-3 text-center', compacto ? 'gap-0 px-1.5 py-1' : 'p-[7.5px]')}
    >
      {celdas.map(([label, valor]) => (
        <div key={label} className="min-w-0">
          <div
            className={cn(
              'truncate capitalize',
              compacto ? 'text-[8px]' : 'text-[9px]',
            )}
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            {label.toLowerCase()}
          </div>
          <div className={cn('font-semibold text-white', compacto ? 'text-[11px]' : 'text-[13px]')}>
            {valor}
          </div>
        </div>
      ))}
    </div>
  );
}

function Acciones({
  node,
  onEdit,
  className,
}: {
  node: BuilderNode;
  onEdit?: (key: string) => void;
  className?: string;
}) {
  const t = useTranslations('Flows.builder');
  const { removeNode, duplicateNode } = useFlowEditor();
  const botones = [
    { label: t('editNode'), icon: Pencil, accion: () => onEdit?.(node.node_key) },
    { label: t('duplicateNode'), icon: Copy, accion: () => duplicateNode(node.node_key) },
    { label: t('deleteNode'), icon: Trash2, accion: () => removeNode(node.node_key) },
  ];
  return (
    <div className={cn('flex shrink-0 items-center gap-[2px]', className)}>
      {botones.map((b) => (
        <button
          key={b.label}
          type="button"
          title={b.label}
          aria-label={b.label}
          onClick={(e) => {
            e.stopPropagation();
            b.accion();
          }}
          className="nodrag flex h-6 w-6 items-center justify-center rounded-[5.6px] text-white/85 transition-colors hover:bg-white/20 hover:text-white"
        >
          <b.icon className="h-[13px] w-[13px]" />
        </button>
      ))}
    </div>
  );
}

/** Contenido de la tarjeta según el tipo de bloque. */
function Contenido({ datos }: { datos: DatosTarjeta }) {
  const t = useTranslations('Flows.builder');
  const tSave = useTranslations('Flows.builder.saveReply');
  const tCond = useTranslations('Flows.builder.condition');
  const tSummary = useTranslations('Flows.summary');
  const { node } = datos;

  if (node.node_type === 'save_reply') {
    const cfg = node.config as unknown as SaveReplyNodeConfig;
    const segundos =
      typeof cfg.espera_segundos === 'number'
        ? cfg.espera_segundos
        : (Number(cfg.espera_minutos) || 0) * 60;
    return (
      <div className="flex flex-col gap-2">
        <Pildora node={node} salida="contesto" fuerte>
          {tSave('waitCustomer')}
        </Pildora>
        {!cfg.esperar_indefinido && (
          <>
            <div className="text-center text-[13px] font-medium text-gray-300">
              {tSave('orNoReply')}
            </div>
            <Pildora node={node} salida="no_contesto" fuerte>
              {tSave('after')} {formatearEspera(segundos, tSummary)}
            </Pildora>
          </>
        )}
      </div>
    );
  }

  if (node.node_type === 'condition') {
    const cfg = node.config as unknown as ConditionNodeConfig;
    const reglas = cfg.rules?.length ?? 0;
    return (
      <div className="flex flex-col gap-2">
        <Pildora node={node} salida="true">
          {tCond(cfg.logic === 'any' ? 'anyRules' : 'allRules')} ·{' '}
          {tCond('ruleCount', { count: reglas })}
        </Pildora>
        <div className="relative pr-[22px] text-[11.25px] leading-snug text-sky-300">
          {t('conditionFallback')}
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{
              ...estiloConector(colorConector(node, 'false')),
              right: -26,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          />
        </div>
      </div>
    );
  }

  const slots = outgoingSlots(node);
  const resumen = node.node_type === 'start' ? datos.disparador : summarizeNode(node, tSummary);

  if (slots.length > 1) {
    return (
      <div className="flex flex-col gap-2">
        {resumen && <p className="line-clamp-3 text-[13px] text-white/85">{resumen}</p>}
        {slots.map((slot) => (
          <Pildora key={slot.id} node={node} salida={slot.id}>
            {slot.label}
          </Pildora>
        ))}
      </div>
    );
  }

  if (!resumen) return null;
  return <p className="line-clamp-4 text-[13px] leading-snug break-words text-white/85">{resumen}</p>;
}

export function TarjetaNodo({ data, selected }: { data: Record<string, unknown>; selected?: boolean }) {
  const t = useTranslations('Flows.builder');
  const datos = data as DatosTarjeta;
  const { node, isFlashed, onEdit } = datos;

  if (node.node_type === 'sale_approved') {
    return <TarjetaVenta datos={datos} selected={selected} />;
  }

  const meta = NODE_META[node.node_type];
  const slots = outgoingSlots(node);
  const esInicio = node.node_type === 'start';
  const multiples = slots.length > 1 || node.node_type === 'condition' || node.node_type === 'save_reply';
  const finDeRama =
    NODOS_FIN_DE_RAMA.has(node.node_type) &&
    !(node.config as { next_node_key?: string }).next_node_key;

  return (
    <div
      className={cn(
        'relative rounded-[12px] p-[3px] text-left text-white transition-shadow',
        selected && 'ring-2 ring-white/70 ring-offset-2 ring-offset-transparent',
        isFlashed && 'ring-2 ring-amber-400',
      )}
      style={{ width: ANCHO_TARJETA, backgroundImage: degradado(node.node_type) }}
    >
      {!esInicio && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ ...estiloConector(GRIS_CONECTOR), left: -10, top: 30, transform: 'none' }}
        />
      )}

      <div className="overflow-hidden rounded-[9px]">
        {/* ---- cabecera ---- */}
        <div
          className="flex h-[60px] items-center gap-[7.5px] p-[11.25px]"
          style={{ backgroundImage: degradado(node.node_type) }}
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border-2 border-white/40 bg-white/15">
            <meta.icon className="h-[18px] w-[18px] text-white" />
          </span>
          <h3 className="line-clamp-2 min-w-0 flex-1 text-[11.25px] leading-tight font-semibold break-words">
            {t(`nodes.${node.node_type}.label`)}
          </h3>
          {!esInicio && <Acciones node={node} onEdit={onEdit} />}
        </div>

        {/* ---- cuerpo ---- */}
        <div style={{ background: FONDO_CUERPO }}>
          <Metricas stats={datos.stats} />
          <div className="px-[15px] pt-[4px] pb-[11.25px] empty:hidden">
            <Contenido datos={datos} />
          </div>
        </div>
      </div>

      {!multiples && slots.length === 1 && (
        <Handle
          type="source"
          id={slots[0].id}
          position={Position.Right}
          style={{
            ...estiloConector(GRIS_CONECTOR),
            right: -10,
            top: 'auto',
            bottom: 24,
            transform: 'none',
          }}
        />
      )}

      {finDeRama && (
        <span
          title={t('endOfBranchHint')}
          className="absolute top-1/2 -right-[54px] -translate-y-1/2 rounded border border-white/15 bg-[#15112d] px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-white/60 uppercase"
        >
          {t('endOfBranch')}
        </span>
      )}
    </div>
  );
}

/** «Venta aprobada»: círculo verde de 90 px con su barra flotante. */
function TarjetaVenta({ datos, selected }: { datos: DatosTarjeta; selected?: boolean }) {
  const t = useTranslations('Flows.builder');
  const { node, onEdit, isFlashed } = datos;
  const slots = outgoingSlots(node);
  return (
    <div className="group/venta relative flex w-[90px] flex-col items-center">
      <div className="absolute -top-[42px] left-1/2 hidden -translate-x-1/2 rounded-[5.6px] border border-gray-600 bg-gray-800/95 p-[3.75px] group-hover/venta:block">
        <Acciones node={node} onEdit={onEdit} />
      </div>
      <Handle
        type="target"
        position={Position.Left}
        style={{ ...estiloConector(GRIS_CONECTOR), left: -10, top: 37, transform: 'none' }}
      />
      <div
        className={cn(
          'flex h-[90px] w-[90px] flex-col items-center justify-center rounded-full border-2 p-[3.75px]',
          selected && 'ring-2 ring-white/70',
          isFlashed && 'ring-2 ring-amber-400',
        )}
        style={{ background: 'rgba(2,44,34,0.65)', borderColor: LEONA_COLOR.sale_approved.from }}
      >
        <NODE_META.sale_approved.icon
          className="mb-0.5 h-7 w-7 shrink-0 drop-shadow-[0_0_10px_rgba(112,246,141,0.75)]"
          style={{ color: LEONA_COLOR.sale_approved.from }}
        />
        <div className="text-center text-[7px] leading-[9px] font-semibold text-white">
          {t('nodes.sale_approved.label')}
        </div>
      </div>
      <div className="mt-1.5 w-[168px] rounded-[5.6px]" style={{ background: FONDO_CUERPO }}>
        <Metricas stats={datos.stats} compacto />
      </div>
      {slots.length === 1 && (
        <Handle
          type="source"
          id={slots[0].id}
          position={Position.Right}
          style={{ ...estiloConector(GRIS_CONECTOR), right: -10, top: 37, transform: 'none' }}
        />
      )}
    </div>
  );
}
