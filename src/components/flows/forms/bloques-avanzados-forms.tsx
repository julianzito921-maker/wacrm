'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
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
  AiBlockNodeConfig,
  ConditionNodeConfig,
  ConditionOperator,
  ConditionRule,
  MetaCapiNodeConfig,
  SetTagNodeConfig,
} from '@/lib/flows/types';

type T = ReturnType<typeof useTranslations>;

function NodeSelect({
  value,
  onChange,
  allNodes,
  currentKey,
  label,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  allNodes: BuilderNode[];
  currentKey: string;
  label: string;
  t: T;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : (v ?? ''))}>
        <SelectTrigger className="bg-muted">
          <SelectValue placeholder={t('pickNextNode')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">—</SelectItem>
          {allNodes
            .filter((n) => n.node_key !== currentKey)
            .map((n) => (
              <SelectItem key={n.node_key} value={n.node_key}>
                {n.node_key}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------
// Condicional múltiple
// ------------------------------------------------------------------
export function ConditionMultiForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: ConditionNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}) {
  const reglas: ConditionRule[] =
    cfg.rules && cfg.rules.length > 0
      ? cfg.rules
      : [
          {
            id: 'r1',
            subject: cfg.subject ?? 'var',
            subject_key: cfg.subject_key ?? '',
            operator: cfg.operator ?? 'equals',
            value: cfg.value,
          },
        ];
  const guardar = (next: ConditionRule[]) => {
    const primera = next[0];
    onUpdateConfig({
      rules: next,
      subject: primera?.subject,
      subject_key: primera?.subject_key,
      operator: primera?.operator,
      value: primera?.value,
    });
  };
  const actualizar = (id: string, patch: Partial<ConditionRule>) =>
    guardar(reglas.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          {t('conditionLogicLabel')}
        </label>
        <div className="bg-muted inline-flex rounded-lg p-0.5">
          {(['all', 'any'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onUpdateConfig({ logic: l })}
              className={`rounded-md px-3 py-1 text-xs ${
                (cfg.logic ?? 'all') === l
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground'
              }`}
            >
              {l === 'all' ? t('conditionAll') : t('conditionAny')}
            </button>
          ))}
        </div>
      </div>

      {reglas.map((r) => {
        const showValue = r.operator === 'equals' || r.operator === 'contains';
        return (
          <div key={r.id} className="border-border bg-card space-y-2 rounded-lg border p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={r.subject}
                onValueChange={(v) =>
                  actualizar(r.id, { subject: (v ?? 'var') as ConditionRule['subject'] })
                }
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="var">{t('capturedVariable')}</SelectItem>
                  <SelectItem value="tag">{t('contactHasTag')}</SelectItem>
                  <SelectItem value="contact_field">{t('contactField')}</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={r.operator}
                onValueChange={(v) =>
                  actualizar(r.id, { operator: (v ?? 'equals') as ConditionOperator })
                }
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="present">{t('isPresent')}</SelectItem>
                  <SelectItem value="absent">{t('isAbsent')}</SelectItem>
                  <SelectItem value="equals">{t('equals')}</SelectItem>
                  <SelectItem value="contains">{t('contains')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={showValue ? 'grid grid-cols-2 gap-2' : ''}>
              <Input
                value={r.subject_key}
                onChange={(e) => actualizar(r.id, { subject_key: e.target.value })}
                placeholder={
                  r.subject === 'var'
                    ? t('varKeyPlaceholder')
                    : r.subject === 'tag'
                      ? t('tagUuidPlaceholder')
                      : t('pickField')
                }
                className="bg-muted font-mono text-xs"
              />
              {showValue && (
                <Input
                  value={r.value ?? ''}
                  onChange={(e) => actualizar(r.id, { value: e.target.value })}
                  placeholder={t('valueLabel')}
                  className="bg-muted"
                />
              )}
            </div>
            {reglas.length > 1 && (
              <button
                type="button"
                className="text-destructive text-[10px]"
                onClick={() => guardar(reglas.filter((x) => x.id !== r.id))}
              >
                {t('removeCondition')}
              </button>
            )}
          </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          guardar([
            ...reglas,
            {
              id: `r${Date.now()}`,
              subject: 'var',
              subject_key: '',
              operator: 'present',
            },
          ])
        }
      >
        + {t('addCondition')}
      </Button>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NodeSelect
          value={cfg.true_next ?? ''}
          onChange={(v) => onUpdateConfig({ true_next: v })}
          allNodes={allNodes}
          currentKey={currentKey}
          label={t('ifTrueAdvance')}
          t={t}
        />
        <NodeSelect
          value={cfg.false_next ?? ''}
          onChange={(v) => onUpdateConfig({ false_next: v })}
          allNodes={allNodes}
          currentKey={currentKey}
          label={t('ifFalseAdvance')}
          t={t}
        />
      </div>
    </>
  );
}

// ------------------------------------------------------------------
// Etiquetas múltiples
// ------------------------------------------------------------------
export function SetTagMultiForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SetTagNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { profile } = useAuth();
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  const [nueva, setNueva] = useState('');
  const [cargando, setCargando] = useState(false);
  const ids = cfg.tag_ids?.length ? cfg.tag_ids : cfg.tag_id ? [cfg.tag_id] : [];

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/tags').catch(() => null);
      if (!res?.ok) return;
      const json = await res.json().catch(() => ({}));
      setTags((json.tags ?? []) as Array<{ id: string; name: string }>);
    })();
  }, []);

  const alternar = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onUpdateConfig({ tag_ids: next, tag_id: next[0] ?? '' });
  };

  const crear = async () => {
    const name = nueva.trim();
    if (!name) return;
    setCargando(true);
    try {
      const { data, error } = await supabase
        .from('tags')
        .insert({ name, color: '#8b5cf6', account_id: profile?.account_id })
        .select('id, name')
        .single();
      if (!error && data) {
        setTags((prev) => [...prev, data as { id: string; name: string }]);
        alternar((data as { id: string }).id);
        setNueva('');
      }
    } finally {
      setCargando(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{t('addTag')}</span>
        <Switch
          checked={(cfg.mode ?? 'add') === 'add'}
          onCheckedChange={(v) => onUpdateConfig({ mode: v ? 'add' : 'remove' })}
          className="data-[state=checked]:bg-violet-500"
        />
        <span className="text-muted-foreground text-xs">{t('removeTag')}</span>
      </div>
      <Input
        value={nueva}
        onChange={(e) => setNueva(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void crear();
          }
        }}
        placeholder={t('createTagPlaceholder')}
        className="bg-muted"
        disabled={cargando}
      />
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => alternar(tag.id)}
            className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs ${
              ids.includes(tag.id)
                ? 'border-violet-500/60 bg-violet-500/10 text-foreground'
                : 'border-border bg-card text-muted-foreground'
            }`}
          >
            {tag.name}
            <span>{ids.includes(tag.id) ? '✓' : ''}</span>
          </button>
        ))}
      </div>
      <NodeSelect
        value={cfg.next_node_key ?? ''}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        allNodes={allNodes}
        currentKey={currentKey}
        label={t('thenAdvanceTo')}
        t={t}
      />
    </>
  );
}

// ------------------------------------------------------------------
// Pixel
// ------------------------------------------------------------------
function MetaCapiBlockForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: MetaCapiNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}) {
  const [pixels, setPixels] = useState<Array<{ pixel_id: string; name: string }>>([]);
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings/tracking/pixels').catch(() => null);
      if (!res?.ok) return;
      const json = await res.json().catch(() => ({}));
      setPixels((json.pixels ?? []) as Array<{ pixel_id: string; name: string }>);
    })();
  }, []);
  const variable = cfg.value_mode === 'variable';
  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t('pixelLabel')}</label>
        <Select
          value={cfg.pixel_id || 'auto'}
          onValueChange={(v) => onUpdateConfig({ pixel_id: v === 'auto' ? undefined : (v ?? '') })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('pixelAuto')}</SelectItem>
            {pixels.map((p) => (
              <SelectItem key={p.pixel_id} value={p.pixel_id}>
                {p.name} · {p.pixel_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t('pageIdLabel')}</label>
        <Input
          value={cfg.page_id ?? ''}
          onChange={(e) => onUpdateConfig({ page_id: e.target.value })}
          placeholder="{{vars.page_id}}"
          className="bg-muted font-mono text-xs"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={cfg.value_mode ?? 'fixed'}
          onValueChange={(v) => onUpdateConfig({ value_mode: v ?? 'fixed' })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">{t('valueModeFixed')}</SelectItem>
            <SelectItem value="variable">{t('valueModeVariable')}</SelectItem>
          </SelectContent>
        </Select>
        {variable ? (
          <Input
            value={cfg.value_var ?? ''}
            onChange={(e) => onUpdateConfig({ value_var: e.target.value })}
            placeholder="monto"
            className="bg-muted font-mono text-xs"
          />
        ) : (
          <Input
            type="number"
            min={0}
            step="0.01"
            value={cfg.value ?? ''}
            onChange={(e) =>
              onUpdateConfig({ value: e.target.value === '' ? undefined : Math.max(Number(e.target.value) || 0, 0) })
            }
            className="bg-muted"
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={cfg.currency ?? 'MXN'}
          onChange={(e) => onUpdateConfig({ currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
          maxLength={3}
          className="bg-muted font-mono text-xs"
        />
        <NodeSelect
          value={cfg.next_node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          allNodes={allNodes}
          currentKey={currentKey}
          label={t('thenAdvanceTo')}
          t={t}
        />
      </div>
    </>
  );
}

export { MetaCapiBlockForm };

// ------------------------------------------------------------------
// Conexión entre flujos y Bloque de IA (paneles)
// ------------------------------------------------------------------
export function ConnectFlowForm({
  cfg,
  onUpdateConfig,
  t,
}: {
  cfg: { target_flow_id?: string };
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}) {
  const [flows, setFlows] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/flows').catch(() => null);
      if (!res?.ok) return;
      const json = await res.json().catch(() => ({}));
      setFlows(
        ((json.flows ?? []) as Array<{ id: string; name: string; status?: string }>).filter(
          (f) => !f.status || f.status === 'active',
        ),
      );
    })();
  }, []);
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{t('targetFlow')}</label>
      <Select
        value={cfg.target_flow_id ?? ''}
        onValueChange={(v) => onUpdateConfig({ target_flow_id: v ?? '' })}
      >
        <SelectTrigger className="bg-muted">
          <SelectValue placeholder={t('pickFlow')} />
        </SelectTrigger>
        <SelectContent>
          {flows.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AiBlockForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: AiBlockNodeConfig;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: T;
}) {
  const condiciones = cfg.conditions ?? [];
  const guardarCond = (next: AiBlockNodeConfig['conditions']) =>
    onUpdateConfig({ conditions: next });

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={cfg.credential_source ?? 'account'}
          onValueChange={(v) => onUpdateConfig({ credential_source: v ?? 'account' })}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="account">{t('aiAccountCredentials')}</SelectItem>
            <SelectItem value="flow">{t('aiManualCredentials')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={cfg.model ?? ''}
          onChange={(e) => onUpdateConfig({ model: e.target.value })}
          placeholder={t('aiModel')}
          className="bg-muted"
        />
      </div>
      <Input
        value={cfg.message_template ?? ''}
        onChange={(e) => onUpdateConfig({ message_template: e.target.value })}
        placeholder="{{last_user_message}}"
        className="bg-muted"
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={cfg.output_var ?? 'ai.response'}
          onChange={(e) => onUpdateConfig({ output_var: e.target.value })}
          className="bg-muted font-mono text-xs"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs">{t('aiAutoSend')}</span>
          <Switch
            checked={cfg.auto_send === true}
            onCheckedChange={(v) => onUpdateConfig({ auto_send: v === true })}
          />
        </div>
      </div>
      <textarea
        value={cfg.prompt ?? ''}
        onChange={(e) => onUpdateConfig({ prompt: e.target.value })}
        rows={4}
        placeholder={t('aiPrompt')}
        className="border-border bg-muted w-full rounded-lg border p-2 text-xs"
      />
      {[
        ['understand_audio', 'aiUnderstandAudio'],
        ['understand_image', 'aiUnderstandImage'],
        ['understand_pdf', 'aiUnderstandPdf'],
        ['identify_receipt', 'aiIdentifyReceipt'],
      ].map(([key, label]) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <span className="text-xs">{t(label)}</span>
          <Switch
            checked={Boolean(cfg[key as keyof AiBlockNodeConfig])}
            onCheckedChange={(v) => onUpdateConfig({ [key]: v === true })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('aiContext')}</span>
        <Input
          type="number"
          min={5}
          max={20}
          value={cfg.context_window ?? 10}
          onChange={(e) =>
            onUpdateConfig({
              context_window: Math.min(Math.max(Number(e.target.value) || 10, 5), 20),
            })
          }
          className="bg-muted w-20"
        />
      </div>
      <div className="space-y-2">
        {condiciones.map((c) => (
          <div key={c.id} className="border-border bg-card space-y-1.5 rounded-lg border p-2">
            <div className="flex gap-2">
              <Input
                value={c.label}
                onChange={(e) =>
                  guardarCond(
                    condiciones.map((x) =>
                      x.id === c.id ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
                placeholder={t('aiConditionLabel')}
                className="bg-muted"
              />
              <button
                type="button"
                className="text-destructive text-xs"
                onClick={() => guardarCond(condiciones.filter((x) => x.id !== c.id))}
              >
                ×
              </button>
            </div>
            <NodeSelect
              value={c.next_node_key}
              onChange={(v) =>
                guardarCond(
                  condiciones.map((x) =>
                    x.id === c.id ? { ...x, next_node_key: v } : x,
                  ),
                )
              }
              allNodes={allNodes}
              currentKey={currentKey}
              label={t('thenAdvanceTo')}
              t={t}
            />
          </div>
        ))}
        {condiciones.length < 10 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              guardarCond([
                ...condiciones,
                {
                  id: `c${Date.now()}`,
                  label: '',
                  next_node_key: '',
                },
              ])
            }
          >
            + {t('aiAddCondition')}
          </Button>
        )}
      </div>
      {cfg.identify_receipt && (
        <NodeSelect
          value={cfg.receipt_next ?? ''}
          onChange={(v) => onUpdateConfig({ receipt_next: v })}
          allNodes={allNodes}
          currentKey={currentKey}
          label={t('aiReceiptNext')}
          t={t}
        />
      )}
      <NodeSelect
        value={cfg.fallback_next ?? ''}
        onChange={(v) => onUpdateConfig({ fallback_next: v })}
        allNodes={allNodes}
        currentKey={currentKey}
        label={t('aiFallbackNext')}
        t={t}
      />
    </>
  );
}
