'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BuilderNode } from '../shared';
import type {
  CarouselNodeConfig,
  DistributorNodeConfig,
  HandoffNodeConfig,
  ManipulatorNodeConfig,
  NotificationNodeConfig,
  SaleApprovedNodeConfig,
} from '@/lib/flows/types';

type T = ReturnType<typeof useTranslations>;

function NodeSelect({ value, onChange, allNodes, currentKey, label, t }: {
  value: string; onChange: (v: string) => void; allNodes: BuilderNode[]; currentKey: string; label: string; t: T;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : (v ?? ''))}>
        <SelectTrigger className="bg-muted"><SelectValue placeholder={t('pickNextNode')} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">—</SelectItem>
          {allNodes.filter((n) => n.node_key !== currentKey).map((n) => (
            <SelectItem key={n.node_key} value={n.node_key}>{n.node_key}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ChatControllerForm({ cfg, onUpdateConfig, t }: {
  cfg: HandoffNodeConfig; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t('chatStatus')}</label>
        <Select value={cfg.status ?? 'pending'} onValueChange={(v) => onUpdateConfig({ status: v ?? 'pending' })}>
          <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">{t('statusPending')}</SelectItem>
            <SelectItem value="open">{t('statusOpen')}</SelectItem>
            <SelectItem value="closed">{t('statusClosed')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('pauseAi')}</span>
        <Switch checked={cfg.pause_ai !== false} onCheckedChange={(v) => onUpdateConfig({ pause_ai: v === true })} />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t('note')}</label>
        <Input value={cfg.note ?? ''} onChange={(e) => onUpdateConfig({ note: e.target.value })} className="bg-muted" />
      </div>
    </>
  );
}

export function ManipulatorForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: ManipulatorNodeConfig; allNodes: BuilderNode[]; currentKey: string; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Select value={cfg.target} onValueChange={(v) => onUpdateConfig({ target: v ?? 'var' })}>
          <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="var">{t('targetVar')}</SelectItem>
            <SelectItem value="contact_field">{t('targetField')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={cfg.operation} onValueChange={(v) => onUpdateConfig({ operation: v ?? 'set' })}>
          <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="set">{t('opSet')}</SelectItem>
            <SelectItem value="add">{t('opAdd')}</SelectItem>
            <SelectItem value="subtract">{t('opSubtract')}</SelectItem>
            <SelectItem value="clear">{t('opClear')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Input value={cfg.key} onChange={(e) => onUpdateConfig({ key: e.target.value })} placeholder={t('manipulatorKey')} className="bg-muted font-mono text-xs" />
      <Input value={cfg.value ?? ''} onChange={(e) => onUpdateConfig({ value: e.target.value })} placeholder="{{vars.x}}" className="bg-muted" />
      <NodeSelect value={cfg.next_node_key} onChange={(v) => onUpdateConfig({ next_node_key: v })} allNodes={allNodes} currentKey={currentKey} label={t('thenAdvanceTo')} t={t} />
    </>
  );
}

export function DistributorForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: DistributorNodeConfig; allNodes: BuilderNode[]; currentKey: string; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  const outputs = cfg.outputs ?? [];
  const guardar = (next: DistributorNodeConfig['outputs']) => onUpdateConfig({ outputs: next });
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('distributorAvoidRepeat')}</span>
        <Switch checked={cfg.mode === 'avoid_repeat'} onCheckedChange={(v) => onUpdateConfig({ mode: v ? 'avoid_repeat' : 'always_next' })} />
      </div>
      {outputs.map((o) => (
        <div key={o.id} className="border-border bg-card space-y-2 rounded-lg border p-2">
          <div className="flex gap-2">
            <Input value={o.label} onChange={(e) => guardar(outputs.map((x) => x.id === o.id ? { ...x, label: e.target.value } : x))} className="bg-muted" placeholder={t('outputLabel')} />
            <button type="button" className="text-destructive text-xs" onClick={() => guardar(outputs.filter((x) => x.id !== o.id))}>×</button>
          </div>
          <NodeSelect value={o.next_node_key} onChange={(v) => guardar(outputs.map((x) => x.id === o.id ? { ...x, next_node_key: v } : x))} allNodes={allNodes} currentKey={currentKey} label={t('thenAdvanceTo')} t={t} />
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => guardar([...outputs, { id: `o${Date.now()}`, label: `Salida ${outputs.length + 1}`, next_node_key: '' }])}>+ {t('addOutput')}</Button>
    </>
  );
}

export function NotificationForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: NotificationNodeConfig; allNodes: BuilderNode[]; currentKey: string; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  return (
    <>
      <Input value={cfg.name} onChange={(e) => onUpdateConfig({ name: e.target.value })} placeholder={t('notificationName')} className="bg-muted" />
      <div className="grid grid-cols-3 gap-2">
        <Input value={cfg.country_code ?? '52'} onChange={(e) => onUpdateConfig({ country_code: e.target.value.replace(/\D/g, '') })} className="bg-muted font-mono" />
        <Input value={cfg.phone} onChange={(e) => onUpdateConfig({ phone: e.target.value.replace(/\D/g, '') })} placeholder="5512345678" className="bg-muted col-span-2 font-mono" />
      </div>
      <textarea value={cfg.message} onChange={(e) => onUpdateConfig({ message: e.target.value })} rows={3} placeholder={t('notificationMessage')} className="border-border bg-muted w-full rounded-lg border p-2 text-xs" />
      <NodeSelect value={cfg.next_node_key ?? ''} onChange={(v) => onUpdateConfig({ next_node_key: v })} allNodes={allNodes} currentKey={currentKey} label={t('thenAdvanceTo')} t={t} />
    </>
  );
}

interface Pipe { id: string; name: string }
interface Stage { id: string; pipeline_id: string; name: string }

export function SaleApprovedForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: SaleApprovedNodeConfig; allNodes: BuilderNode[]; currentKey: string; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  const supabase = useMemo(() => (typeof window === 'undefined' ? null : createClient()), []);
  const [pipes, setPipes] = useState<Pipe[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  useEffect(() => {
    if (!supabase) return;
    void (async () => {
      const [{ data: p }, { data: s }] = await Promise.all([
        supabase.from('pipelines').select('id, name').order('created_at'),
        supabase.from('pipeline_stages').select('id, pipeline_id, name').order('position'),
      ]);
      setPipes((p ?? []) as Pipe[]);
      setStages((s ?? []) as Stage[]);
    })();
  }, [supabase]);
  const stageList = stages.filter((s) => s.pipeline_id === cfg.pipeline_id);
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Select value={cfg.pipeline_id || 'none'} onValueChange={(v) => onUpdateConfig({ pipeline_id: v === 'none' ? '' : (v ?? ''), stage_id: '' })}>
          <SelectTrigger className="bg-muted"><SelectValue placeholder={t('salePipeline')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">—</SelectItem>
            {pipes.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={cfg.stage_id || 'none'} onValueChange={(v) => onUpdateConfig({ stage_id: v === 'none' ? '' : (v ?? '') })}>
          <SelectTrigger className="bg-muted"><SelectValue placeholder={t('saleStage')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">—</SelectItem>
            {stageList.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input value={cfg.name_var ?? ''} onChange={(e) => onUpdateConfig({ name_var: e.target.value })} placeholder={t('saleNameVar')} className="bg-muted font-mono text-xs" />
        <Input value={cfg.amount_var} onChange={(e) => onUpdateConfig({ amount_var: e.target.value })} placeholder={t('saleAmountVar')} className="bg-muted font-mono text-xs" />
      </div>
      <Input value={cfg.currency_var ?? ''} onChange={(e) => onUpdateConfig({ currency_var: e.target.value })} placeholder={t('saleCurrencyVar')} className="bg-muted font-mono text-xs" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('saleCapi')}</span>
        <Switch checked={cfg.send_capi !== false} onCheckedChange={(v) => onUpdateConfig({ send_capi: v === true })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('saleNotify')}</span>
        <Switch checked={cfg.notify !== false} onCheckedChange={(v) => onUpdateConfig({ notify: v === true })} />
      </div>
      <NodeSelect value={cfg.next_node_key ?? ''} onChange={(v) => onUpdateConfig({ next_node_key: v })} allNodes={allNodes} currentKey={currentKey} label={t('thenAdvanceTo')} t={t} />
    </>
  );
}

export function CarouselForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: CarouselNodeConfig; allNodes: BuilderNode[]; currentKey: string; onUpdateConfig: (p: Record<string, unknown>) => void; t: T;
}) {
  const cards = cfg.cards ?? [];
  const guardar = (next: CarouselNodeConfig['cards']) => onUpdateConfig({ cards: next });
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Input type="number" min={1} max={31} value={cfg.expires_days} onChange={(e) => onUpdateConfig({ expires_days: Math.min(Math.max(Number(e.target.value) || 1, 1), 31) })} className="bg-muted" />
        <Input value={cfg.intro_text ?? ''} onChange={(e) => onUpdateConfig({ intro_text: e.target.value })} placeholder={t('carouselIntro')} className="bg-muted" />
      </div>
      {cards.map((card) => (
        <div key={card.id} className="border-border bg-card space-y-2 rounded-lg border p-2">
          <div className="flex gap-2">
            <Input value={card.text} onChange={(e) => guardar(cards.map((c) => c.id === card.id ? { ...c, text: e.target.value } : c))} className="bg-muted" placeholder={t('carouselText')} />
            <button type="button" className="text-destructive text-xs" onClick={() => guardar(cards.filter((c) => c.id !== card.id))}>×</button>
          </div>
          <Input value={card.image_url ?? ''} onChange={(e) => guardar(cards.map((c) => c.id === card.id ? { ...c, image_url: e.target.value } : c))} className="bg-muted font-mono text-xs" placeholder="https://…" />
          {card.buttons.map((b) => (
            <div key={b.id} className="border-border space-y-1 rounded border p-1.5">
              <div className="flex gap-1">
                <Input value={b.label} onChange={(e) => guardar(cards.map((c) => c.id === card.id ? { ...c, buttons: c.buttons.map((x) => x.id === b.id ? { ...x, label: e.target.value } : x) } : c))} className="bg-muted" placeholder={t('buttonLabel')} />
                <button type="button" className="text-destructive text-xs" onClick={() => guardar(cards.map((c) => c.id === card.id ? { ...c, buttons: c.buttons.filter((x) => x.id !== b.id) } : c))}>×</button>
              </div>
              <NodeSelect value={b.next_node_key ?? ''} onChange={(v) => guardar(cards.map((c) => c.id === card.id ? { ...c, buttons: c.buttons.map((x) => x.id === b.id ? { ...x, next_node_key: v } : x) } : c))} allNodes={allNodes} currentKey={currentKey} label={t('thenAdvanceTo')} t={t} />
            </div>
          ))}
          {card.buttons.length < 3 && (
            <Button variant="ghost" size="sm" onClick={() => guardar(cards.map((c) => c.id === card.id ? { ...c, buttons: [...c.buttons, { id: `b${Date.now()}`, label: '', type: 'reply', next_node_key: '' }] } : c))}>+ {t('addButton')}</Button>
          )}
        </div>
      ))}
      {cards.length < 10 && (
        <Button variant="outline" size="sm" onClick={() => guardar([...cards, { id: `c${Date.now()}`, text: '', image_url: '', buttons: [] }])}>+ {t('addCard')}</Button>
      )}
      <NodeSelect value={cfg.timeout_next ?? ''} onChange={(v) => onUpdateConfig({ timeout_next: v })} allNodes={allNodes} currentKey={currentKey} label={t('carouselTimeout')} t={t} />
    </>
  );
}
