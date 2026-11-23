'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  Download,
  Eye,
  HandCoins,
  Megaphone,
  MessageSquare,
  Pencil,
  Percent,
  Plus,
  Receipt,
  RefreshCw,
  ShoppingBag,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------------
// Tipos
// ------------------------------------------------------------------
type PeriodKey = 'today' | 'yesterday' | '7d' | 'month' | 'custom';
type Tab = 'sales' | 'attention';
type Mode = 'value' | 'count';

interface SalesKpis {
  leads: number;
  revenue: number;
  sales: number;
  spend: number;
  roas: number;
  conversion: number;
  ticket: number;
  profit: number;
}
interface PreviousKpis {
  leads: number;
  revenue: number;
  sales: number;
  spend: number;
}
interface SalesPoint {
  t: string;
  revenue: number;
  count: number;
}
interface HourPoint {
  hour: number;
  count: number;
  revenue: number;
}
interface BreakdownRow {
  id: string;
  label?: string;
  state?: string;
  name?: string;
  count: number;
  revenue: number;
}
interface HistoryRow {
  id: string;
  client_name: string | null;
  amount: number;
  currency: string;
  payment_id: string | null;
  meta_ref: string | null;
  region: string | null;
  status: string;
  sold_at: string;
  lead_number: number | null;
  conversation_id: string | null;
  instance_label: string;
  instance_number: string | null;
  product_name: string;
}
interface SalesData {
  period: { from: string; to: string; currency: string; unit: 'hour' | 'day' };
  kpis: SalesKpis;
  previous: PreviousKpis;
  series: SalesPoint[];
  hourly: HourPoint[];
  by_instance: BreakdownRow[];
  by_state: BreakdownRow[];
  by_product: BreakdownRow[];
  history: HistoryRow[];
  currencies: string[];
}
interface AttentionKpis {
  new_conversations: number;
  waiting: number;
  unassigned: number;
  avg_response: number;
  within_target_pct: number;
  closed: number;
  incoming: number;
  outgoing: number;
}
interface AttentionData {
  period: { from: string; to: string; unit: 'hour' | 'day'; target_minutes: number };
  kpis: AttentionKpis;
  previous: Partial<AttentionKpis>;
  series: Array<{ t: string; incoming: number; outgoing: number; avg_response: number | null }>;
  hourly: Array<{ hour: number; incoming: number; outgoing: number }>;
}

interface Product {
  id: string;
  nombre: string;
  precio: number | null;
  moneda: string | null;
  activo: boolean;
}
interface Connection {
  id: string;
  phone_number_id: string;
  status: string;
}
interface Agent {
  user_id: string;
  full_name: string | null;
  email: string;
}

const VISIBLE_DEFAULT: Record<string, boolean> = {
  kpi_leads: true,
  kpi_revenue: true,
  kpi_sales: true,
  kpi_roas: true,
  kpi_conversion: true,
  kpi_ticket: true,
  kpi_profit: true,
  kpi_spend: true,
  charts: true,
  breakdowns: true,
  history: true,
  products: true,
};

const MX_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche', 'Chiapas',
  'Chihuahua', 'Ciudad de México', 'Coahuila', 'Colima', 'Durango', 'Estado de México',
  'Guanajuato', 'Guerrero', 'Hidalgo', 'Jalisco', 'Michoacán', 'Morelos', 'Nayarit',
  'Nuevo León', 'Oaxaca', 'Puebla', 'Querétaro', 'Quintana Roo', 'San Luis Potosí',
  'Sinaloa', 'Sonora', 'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz', 'Yucatán',
  'Zacatecas',
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}
function dateInput(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function parseDateInput(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function rangeFor(period: PeriodKey, custom: { from: string; to: string }) {
  const now = new Date();
  const today = startOfDay(now);
  if (period === 'today') return { from: today, to: addDays(today, 1) };
  if (period === 'yesterday') return { from: addDays(today, -1), to: today };
  if (period === '7d') return { from: addDays(today, -6), to: addDays(today, 1) };
  if (period === 'month') {
    return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: addDays(today, 1) };
  }
  const from = custom.from ? parseDateInput(custom.from) : today;
  const to = custom.to ? parseDateInput(custom.to) : today;
  return { from: startOfDay(from), to: addDays(startOfDay(to), 1) };
}
function variation(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

// ------------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------------
export function DashboardView() {
  const t = useTranslations('Dashboard');
  const locale = useLocale();
  const { defaultCurrency, profile, canEditSettings } = useAuth();
  const supabase = useMemo(
    () => (typeof window === 'undefined' ? null : createClient()),
    [],
  );
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    [],
  );

  const [tab, setTab] = useState<Tab>('sales');
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [custom, setCustom] = useState({ from: dateInput(new Date()), to: dateInput(new Date()) });
  const [instance, setInstance] = useState('all');
  const [product, setProduct] = useState('all');
  const [agent, setAgent] = useState('all');
  const [currency, setCurrency] = useState(defaultCurrency || 'MXN');
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [salesData, setSalesData] = useState<SalesData | null>(null);
  const [attentionData, setAttentionData] = useState<AttentionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>(VISIBLE_DEFAULT);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [editSale, setEditSale] = useState<HistoryRow | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  const range = useMemo(() => rangeFor(period, custom), [period, custom]);
  const fromISO = range.from.toISOString();
  const toISO = range.to.toISOString();

  useEffect(() => {
    try {
      const saved = localStorage.getItem('wacrm.dashboard.visible');
      if (saved) setVisible({ ...VISIBLE_DEFAULT, ...JSON.parse(saved) });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!currencyTouched && defaultCurrency) setCurrency(defaultCurrency);
  }, [defaultCurrency, currencyTouched]);

  useEffect(() => {
    const accountId = profile?.account_id;
    if (!accountId || !supabase) return;
    let alive = true;
    void (async () => {
      const [prod, conn, ag] = await Promise.all([
        supabase
          .from('product_catalog')
          .select('id, nombre, precio, moneda, activo')
          .eq('account_id', accountId)
          .order('orden', { ascending: true })
          .order('nombre', { ascending: true }),
        supabase
          .from('whatsapp_config')
          .select('id, phone_number_id, status')
          .eq('account_id', accountId),
        supabase
          .from('profiles')
          .select('user_id, full_name, email')
          .eq('account_id', accountId),
      ]);
      if (!alive) return;
      setProducts((prod.data ?? []) as Product[]);
      setConnections((conn.data ?? []) as Connection[]);
      setAgents((ag.data ?? []) as Agent[]);
    })();
    return () => {
      alive = false;
    };
  }, [profile?.account_id, supabase]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setFailed(false);
    try {
      if (tab === 'sales') {
        const { data, error } = await supabase.rpc('dashboard_sales', {
          p_from: fromISO,
          p_to: toISO,
          p_instance_id: instance === 'all' ? null : instance,
          p_product_id: product === 'all' ? null : product,
          p_agent_id: agent === 'all' ? null : agent,
          p_currency: currency || null,
          p_tz: timezone,
        });
        if (error) throw new Error(error.message);
        setSalesData(data as SalesData);
      } else {
        const { data, error } = await supabase.rpc('dashboard_attention', {
          p_from: fromISO,
          p_to: toISO,
          p_agent_id: agent === 'all' ? null : agent,
          p_tz: timezone,
        });
        if (error) throw new Error(error.message);
        setAttentionData(data as AttentionData);
      }
    } catch (err) {
      console.error('[dashboard] load failed:', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tab, fromISO, toISO, instance, product, agent, currency, timezone, supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: string, value: boolean) => {
    const next = { ...visible, [key]: value };
    setVisible(next);
    try {
      localStorage.setItem('wacrm.dashboard.visible', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const money = (value: number, code = currency) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code || 'MXN',
        currencyDisplay: 'code',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value) || 0);
    } catch {
      return `${code} ${(Number(value) || 0).toFixed(2)}`;
    }
  };
  const integer = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const percent = (value: number) => `${(Number(value) || 0).toFixed(2)}%`;
  const roasFmt = (value: number) => (Number(value) || 0).toFixed(2);
  const minutesFmt = (value: number) => {
    const v = Math.max(0, Number(value) || 0);
    if (v < 60) return `${Math.round(v)} min`;
    return `${Math.floor(v / 60)} h ${Math.round(v % 60)} min`;
  };

  const k = salesData?.kpis;
  const p = salesData?.previous;
  const prevProfit = p ? p.revenue - p.spend : 0;
  const prevConversion = p && p.leads > 0 ? (p.sales / p.leads) * 100 : 0;
  const prevTicket = p && p.sales > 0 ? p.revenue / p.sales : 0;
  const prevRoas = p && p.spend > 0 ? p.revenue / p.spend : 0;

  const a = attentionData?.kpis;
  const ap = attentionData?.previous;

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    if (defaultCurrency) set.add(defaultCurrency);
    for (const c of salesData?.currencies ?? []) if (c) set.add(c);
    set.add(currency);
    return [...set];
  }, [defaultCurrency, salesData?.currencies, currency]);

  const selectedPeriodLabel =
    period === 'today'
      ? t('filters.periodToday')
      : period === 'yesterday'
        ? t('filters.periodYesterday')
        : period === '7d'
          ? t('filters.period7d')
          : period === 'month'
            ? t('filters.periodMonth')
            : `${custom.from} → ${custom.to}`;

  return (
    <div className="space-y-4">
      {/* Barra de filtros */}
      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-xl border p-2.5">
        <div className="bg-muted flex rounded-lg p-0.5">
          {(['sales', 'attention'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                tab === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {key === 'sales' ? t('filters.salesTab') : t('filters.attentionTab')}
            </button>
          ))}
        </div>

        <Select
          value={period}
          onValueChange={(v) => {
            const next = (v ?? 'today') as PeriodKey;
            setPeriod(next);
            if (next === 'custom') setPeriodOpen(true);
          }}
        >
          <SelectTrigger className="bg-muted h-8 w-[170px] text-xs">
            <SelectValue>{selectedPeriodLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">{t('filters.periodToday')}</SelectItem>
            <SelectItem value="yesterday">{t('filters.periodYesterday')}</SelectItem>
            <SelectItem value="7d">{t('filters.period7d')}</SelectItem>
            <SelectItem value="month">{t('filters.periodMonth')}</SelectItem>
            <SelectItem value="custom">{t('filters.periodCustom')}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={instance} onValueChange={(v) => setInstance(v ?? 'all')}>
          <SelectTrigger className="bg-muted h-8 w-[180px] text-xs">
            <SelectValue placeholder={t('filters.allConnections')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.allConnections')}</SelectItem>
            {connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                WhatsApp …{c.phone_number_id.slice(-4)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {tab === 'sales' && (
          <Select value={product} onValueChange={(v) => setProduct(v ?? 'all')}>
            <SelectTrigger className="bg-muted h-8 w-[180px] text-xs">
              <SelectValue placeholder={t('filters.allProducts')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.allProducts')}</SelectItem>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Select value={agent} onValueChange={(v) => setAgent(v ?? 'all')}>
            <SelectTrigger className="bg-muted h-8 w-[170px] text-xs">
              <SelectValue placeholder={t('filters.allAccounts')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.allAccounts')}</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.user_id} value={a.user_id}>
                  {a.full_name || a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {tab === 'sales' && (
            <Select
              value={currency}
              onValueChange={(v) => {
                setCurrencyTouched(true);
                setCurrency(v ?? 'MXN');
              }}
            >
              <SelectTrigger className="bg-muted h-8 w-[100px] font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencyOptions.map((c) => (
                  <SelectItem key={c} value={c} className="font-mono">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button size="icon" variant="ghost" onClick={() => void load()} aria-label={t('filters.refresh')}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              className="hover:bg-muted inline-flex size-8 items-center justify-center rounded-lg"
              aria-label={t('filters.visibility')}
            >
              <Eye className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover w-56">
              <DropdownMenuLabel>{t('filters.visibility')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {Object.entries(visible).map(([key, value]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={value}
                  onCheckedChange={(v) => toggle(key, v === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {t(`filters.visible.${key}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {failed && !loading && (
        <div className="border-border bg-card flex items-center justify-between gap-3 rounded-xl border p-4 text-sm">
          <span className="text-muted-foreground">{t('common.loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {tab === 'sales' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {visible.kpi_leads && (
              <MetricCard
                icon={UserPlus}
                label={t('sales.kpis.leads')}
                value={integer(k?.leads ?? 0)}
                variation={variation(k?.leads ?? 0, p?.leads ?? 0)}
                subtitle={t('sales.kpis.leadsHint')}
              />
            )}
            {visible.kpi_revenue && (
              <MetricCard
                icon={Wallet}
                label={t('sales.kpis.revenue')}
                value={money(k?.revenue ?? 0)}
                variation={variation(k?.revenue ?? 0, p?.revenue ?? 0)}
                accent="green"
                subtitle={t('sales.kpis.revenueHint')}
              />
            )}
            {visible.kpi_sales && (
              <MetricCard
                icon={ShoppingBag}
                label={t('sales.kpis.sales')}
                value={integer(k?.sales ?? 0)}
                variation={variation(k?.sales ?? 0, p?.sales ?? 0)}
                subtitle={t('sales.kpis.salesHint')}
              />
            )}
            {visible.kpi_roas && (
              <MetricCard
                icon={TrendingUp}
                label={t('sales.kpis.roas')}
                value={roasFmt(k?.roas ?? 0)}
                variation={variation(k?.roas ?? 0, prevRoas)}
                accent="gold"
                subtitle={t('sales.kpis.roasHint')}
              />
            )}
            {visible.kpi_conversion && (
              <MetricCard
                icon={Percent}
                label={t('sales.kpis.conversion')}
                value={percent(k?.conversion ?? 0)}
                variation={variation(k?.conversion ?? 0, prevConversion)}
                subtitle={t('sales.kpis.conversionHint')}
              />
            )}
            {visible.kpi_ticket && (
              <MetricCard
                icon={Receipt}
                label={t('sales.kpis.ticket')}
                value={money(k?.ticket ?? 0)}
                variation={variation(k?.ticket ?? 0, prevTicket)}
                subtitle={t('sales.kpis.ticketHint')}
              />
            )}
            {visible.kpi_profit && (
              <MetricCard
                icon={HandCoins}
                label={t('sales.kpis.profit')}
                value={money(k?.profit ?? 0)}
                variation={variation(k?.profit ?? 0, prevProfit)}
                accent="green"
                subtitle={t('sales.kpis.profitHint')}
              />
            )}
            {visible.kpi_spend && (
              <MetricCard
                icon={Megaphone}
                label={t('sales.kpis.spend')}
                value={money(k?.spend ?? 0)}
                variation={variation(k?.spend ?? 0, p?.spend ?? 0)}
                accent="red"
                subtitle={t('sales.kpis.spendHint')}
                action={canEditSettings ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('sales.spend.edit')}
                      onClick={() => setSpendOpen(true)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('sales.spend.sync')}
                      onClick={async () => {
                        const res = await fetch('/api/dashboard/ad-spend/sync', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ from: dateInput(range.from), to: dateInput(addDays(range.to, -1)) }),
                        });
                        const json = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          toast.error(
                            json.error === 'not_configured'
                              ? t('sales.spend.notConfigured')
                              : t('common.genericError'),
                          );
                          return;
                        }
                        toast.success(t('sales.spend.synced', { count: json.synced ?? 0 }));
                        void load();
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </div>
                ) : undefined}
              />
            )}
          </div>

          {visible.charts && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
              <SalesPeriodChart
                series={salesData?.series ?? []}
                unit={salesData?.period.unit ?? 'hour'}
                locale={locale}
                currency={currency}
                money={money}
                t={t}
              />
              <HourlyChart hourly={salesData?.hourly ?? []} money={money} t={t} />
            </div>
          )}

          {visible.breakdowns && (
            <div className="grid gap-4 md:grid-cols-3">
              <BreakdownCard
                title={t('sales.breakdown.byInstance')}
                subtitle={t('sales.breakdown.byInstanceHint')}
                rows={(salesData?.by_instance ?? []).map((r) => ({
                  key: r.id,
                  label: r.label ?? r.id,
                  count: r.count,
                  revenue: r.revenue,
                }))}
                mode="count"
                money={money}
                t={t}
              />
              <BreakdownCard
                title={t('sales.breakdown.revenueByInstance')}
                subtitle={t('sales.breakdown.revenueByInstanceHint')}
                rows={(salesData?.by_instance ?? []).map((r) => ({
                  key: r.id,
                  label: r.label ?? r.id,
                  count: r.count,
                  revenue: r.revenue,
                }))}
                mode="value"
                money={money}
                t={t}
              />
              <BreakdownCard
                title={t('sales.breakdown.byState')}
                subtitle={t('sales.breakdown.byStateHint')}
                rows={(salesData?.by_state ?? []).map((r) => ({
                  key: r.state ?? r.id,
                  label: r.state ?? '—',
                  count: r.count,
                  revenue: r.revenue,
                }))}
                mode="count"
                money={money}
                t={t}
              />
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
            {visible.history && (
              <SalesHistory
                rows={salesData?.history ?? []}
                locale={locale}
                money={money}
                t={t}
                onEdit={(row) => {
                  setEditSale(row);
                  setSaleOpen(true);
                }}
                onRefresh={() => void load()}
                filters={{ fromISO, toISO, instance, product, agent, currency }}
              />
            )}
            {visible.products && (
              <ProductPerformance
                rows={(salesData?.by_product ?? []).map((r) => ({
                  key: r.id,
                  label: r.name ?? r.id,
                  count: r.count,
                  revenue: r.revenue,
                }))}
                money={money}
                t={t}
              />
            )}
          </div>

          <Button
            className="fixed right-4 bottom-4 z-20 shadow-lg sm:right-6 sm:bottom-6"
            onClick={() => {
              setEditSale(null);
              setSaleOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t('sales.newSale')}
          </Button>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={MessageSquare}
              label={t('attention.kpis.newConversations')}
              value={integer(a?.new_conversations ?? 0)}
              variation={variation(a?.new_conversations ?? 0, ap?.new_conversations ?? 0)}
              subtitle={t('attention.kpis.newConversationsHint')}
            />
            <MetricCard
              icon={Users}
              label={t('attention.kpis.waiting')}
              value={integer(a?.waiting ?? 0)}
              variation={null}
              accent="gold"
              subtitle={t('attention.kpis.waitingHint')}
            />
            <MetricCard
              icon={UserPlus}
              label={t('attention.kpis.unassigned')}
              value={integer(a?.unassigned ?? 0)}
              variation={null}
              subtitle={t('attention.kpis.unassignedHint')}
            />
            <MetricCard
              icon={CalendarDays}
              label={t('attention.kpis.avgResponse')}
              value={minutesFmt(a?.avg_response ?? 0)}
              variation={variation(a?.avg_response ?? 0, ap?.avg_response ?? 0)}
              invert
              subtitle={t('attention.kpis.avgResponseHint')}
            />
            <MetricCard
              icon={Check}
              label={t('attention.kpis.withinTarget')}
              value={percent(a?.within_target_pct ?? 0)}
              variation={variation(a?.within_target_pct ?? 0, ap?.within_target_pct ?? 0)}
              accent="green"
              subtitle={t('attention.kpis.withinTargetHint', {
                minutes: attentionData?.period.target_minutes ?? 5,
              })}
            />
            <MetricCard
              icon={ShoppingBag}
              label={t('attention.kpis.closed')}
              value={integer(a?.closed ?? 0)}
              variation={variation(a?.closed ?? 0, ap?.closed ?? 0)}
              subtitle={t('attention.kpis.closedHint')}
            />
            <MetricCard
              icon={ArrowDownRight}
              label={t('attention.kpis.incoming')}
              value={integer(a?.incoming ?? 0)}
              variation={variation(a?.incoming ?? 0, ap?.incoming ?? 0)}
              subtitle={t('attention.kpis.incomingHint')}
            />
            <MetricCard
              icon={ArrowUpRight}
              label={t('attention.kpis.outgoing')}
              value={integer(a?.outgoing ?? 0)}
              variation={variation(a?.outgoing ?? 0, ap?.outgoing ?? 0)}
              accent="green"
              subtitle={t('attention.kpis.outgoingHint')}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <AttentionVolumeChart
              series={attentionData?.series ?? []}
              unit={attentionData?.period.unit ?? 'hour'}
              locale={locale}
              t={t}
            />
            <ResponseTimeChart
              series={attentionData?.series ?? []}
              unit={attentionData?.period.unit ?? 'hour'}
              locale={locale}
              minutesFmt={minutesFmt}
              t={t}
            />
          </div>
        </>
      )}

      <PeriodDialog
        open={periodOpen}
        onOpenChange={setPeriodOpen}
        value={custom}
        onChange={setCustom}
        onApply={(next) => {
          setCustom(next);
          setPeriod('custom');
        }}
        t={t}
      />

      <SaleDialog
        open={saleOpen}
        onOpenChange={(open) => {
          setSaleOpen(open);
          if (!open) setEditSale(null);
        }}
        sale={editSale}
        products={products}
        connections={connections}
        currency={currency}
        accountId={profile?.account_id ?? null}
        onSaved={() => void load()}
        t={t}
      />

      <AdSpendDialog
        open={spendOpen}
        onOpenChange={setSpendOpen}
        from={dateInput(range.from)}
        to={dateInput(addDays(range.to, -1))}
        onSaved={() => void load()}
        t={t}
      />
    </div>
  );
}

// ------------------------------------------------------------------
// Tarjeta KPI
// ------------------------------------------------------------------
const ACCENTS = {
  default: 'text-foreground',
  green: 'text-emerald-400',
  gold: 'text-amber-400',
  red: 'text-rose-400',
  purple: 'text-violet-400',
} as const;

function MetricCard({
  icon: Icon,
  label,
  value,
  variation: v,
  invert,
  accent = 'default',
  subtitle,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  variation: number | null;
  invert?: boolean;
  accent?: keyof typeof ACCENTS;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const up = (v ?? 0) > 0;
  const down = (v ?? 0) < 0;
  const good = invert ? down : up;
  const bad = invert ? up : down;
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg">
          <Icon className="size-4" />
        </span>
        <div className="flex items-center gap-1">
          {action}
          <Badge
            variant="outline"
            className={cn(
              'font-mono text-[10px]',
              good && 'border-emerald-500/30 text-emerald-400',
              bad && 'border-rose-500/30 text-rose-400',
              !good && !bad && 'text-muted-foreground',
            )}
          >
            {v === null
              ? '0.00%'
              : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`}
          </Badge>
        </div>
      </div>
      <p className="text-muted-foreground mt-3 truncate text-[11px] font-medium">
        {label}
      </p>
      <p className={cn('mt-0.5 truncate text-2xl font-semibold tracking-tight', ACCENTS[accent])}>
        {value}
      </p>
      {subtitle && (
        <p className="text-muted-foreground mt-1 truncate text-[10.5px]">{subtitle}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Gráficas
// ------------------------------------------------------------------
function formatBucket(t: string, unit: 'hour' | 'day', locale: string): string {
  const d = new Date(t);
  if (unit === 'hour') return `${String(d.getHours()).padStart(2, '0')}h`;
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(d);
}

function SalesPeriodChart({
  series,
  unit,
  locale,
  currency,
  money,
  t,
}: {
  series: SalesPoint[];
  unit: 'hour' | 'day';
  locale: string;
  currency: string;
  money: (v: number) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [mode, setMode] = useState<Mode>('value');
  const data = series.map((s) => ({
    ...s,
    label: formatBucket(s.t, unit, locale),
  }));
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-foreground text-sm font-semibold">{t('sales.charts.periodTitle')}</h3>
          <p className="text-muted-foreground text-[11px]">{t('sales.charts.periodHint')}</p>
        </div>
        <ModeToggle mode={mode} setMode={setMode} t={t} />
      </div>
      <div className="mt-3 h-[270px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} width={52} />
            <Tooltip
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e4e4e7' }}
              formatter={(value) =>
                mode === 'value'
                  ? [money(Number(value)), currency]
                  : [String(value), t('sales.charts.count')]
              }
            />
            <Area
              type="monotone"
              dataKey={mode === 'value' ? 'revenue' : 'count'}
              stroke="#8b5cf6"
              strokeWidth={2}
              fill="url(#salesFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function HourlyChart({
  hourly,
  money,
  t,
}: {
  hourly: HourPoint[];
  money: (v: number) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  const data = hourly.map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}h` }));
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground text-sm font-semibold">{t('sales.charts.hourlyTitle')}</h3>
      <p className="text-muted-foreground text-[11px]">{t('sales.charts.hourlyHint')}</p>
      <div className="mt-3 h-[270px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#71717a', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval={2}
            />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
            <Tooltip
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e4e4e7' }}
              formatter={(value, name) =>
                name === 'count' ? [String(value), t('sales.charts.count')] : [money(Number(value)), t('sales.charts.value')]
              }
            />
            <Bar dataKey="count" fill="#22c55e" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AttentionVolumeChart({
  series,
  unit,
  locale,
  t,
}: {
  series: AttentionData['series'];
  unit: 'hour' | 'day';
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const data = series.map((s) => ({
    ...s,
    label: formatBucket(s.t, unit, locale),
  }));
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground text-sm font-semibold">{t('attention.charts.volumeTitle')}</h3>
      <p className="text-muted-foreground text-[11px]">{t('attention.charts.volumeHint')}</p>
      <div className="mt-3 h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e4e4e7' }}
            />
            <Area type="monotone" dataKey="incoming" name={t('attention.charts.incoming')} stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.18} />
            <Area type="monotone" dataKey="outgoing" name={t('attention.charts.outgoing')} stroke="#22c55e" fill="#22c55e" fillOpacity={0.12} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ResponseTimeChart({
  series,
  unit,
  locale,
  minutesFmt,
  t,
}: {
  series: AttentionData['series'];
  unit: 'hour' | 'day';
  locale: string;
  minutesFmt: (v: number) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  const data = series.map((s) => ({
    ...s,
    label: formatBucket(s.t, unit, locale),
    avg_response: s.avg_response ?? 0,
  }));
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground text-sm font-semibold">{t('attention.charts.responseTitle')}</h3>
      <p className="text-muted-foreground text-[11px]">{t('attention.charts.responseHint')}</p>
      <div className="mt-3 h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e4e4e7' }}
              formatter={(value) => [minutesFmt(Number(value)), t('attention.charts.response')]}
            />
            <Line type="monotone" dataKey="avg_response" stroke="#f59e0b" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  setMode,
  t,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="bg-muted flex rounded-md p-0.5">
      {(['value', 'count'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={cn(
            'rounded px-2 py-1 text-[10px] font-medium',
            mode === m ? 'bg-background text-foreground' : 'text-muted-foreground',
          )}
        >
          {m === 'value' ? t('sales.charts.value') : t('sales.charts.count')}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------
// Desgloses y productos
// ------------------------------------------------------------------
interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  revenue: number;
}

function BreakdownCard({
  title,
  subtitle,
  rows,
  mode,
  money,
  t,
}: {
  title: string;
  subtitle: string;
  rows: BreakdownItem[];
  mode: Mode;
  money: (v: number) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  const totals = rows.reduce(
    (acc, r) => ({
      count: acc.count + r.count,
      revenue: acc.revenue + r.revenue,
    }),
    { count: 0, revenue: 0 },
  );
  const total = mode === 'value' ? totals.revenue : totals.count;
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground text-[11px]">{subtitle}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-xs">{t('common.noData')}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.slice(0, 6).map((r) => {
            const value = mode === 'value' ? r.revenue : r.count;
            const share = total > 0 ? (value / total) * 100 : 0;
            return (
              <li key={r.key}>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground truncate">{r.label}</span>
                  <span className="text-muted-foreground shrink-0 font-mono">
                    {mode === 'value' ? money(value) : value}
                  </span>
                </div>
                <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-violet-500 h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProductPerformance({
  rows,
  money,
  t,
}: {
  rows: BreakdownItem[];
  money: (v: number) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [mode, setMode] = useState<Mode>('value');
  const total = rows.reduce((sum, r) => sum + (mode === 'value' ? r.revenue : r.count), 0);
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-foreground text-sm font-semibold">{t('sales.products.title')}</h3>
          <p className="text-muted-foreground text-[11px]">{t('sales.products.hint')}</p>
        </div>
        <ModeToggle mode={mode} setMode={setMode} t={t} />
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-xs">{t('common.noData')}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.slice(0, 8).map((r) => {
            const value = mode === 'value' ? r.revenue : r.count;
            const share = total > 0 ? (value / total) * 100 : 0;
            return (
              <li key={r.key}>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground truncate">{r.label}</span>
                  <span className="text-muted-foreground shrink-0 font-mono">
                    {mode === 'value' ? money(value) : value} · {share.toFixed(0)}%
                  </span>
                </div>
                <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-emerald-500 h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Historial
// ------------------------------------------------------------------
function SalesHistory({
  rows,
  locale,
  money,
  t,
  onEdit,
  onRefresh,
  filters,
}: {
  rows: HistoryRow[];
  locale: string;
  money: (v: number, code?: string) => string;
  t: ReturnType<typeof useTranslations>;
  onEdit: (row: HistoryRow) => void;
  onRefresh: () => void;
  filters: {
    fromISO: string;
    toISO: string;
    instance: string;
    product: string;
    agent: string;
    currency: string;
  };
}) {
  const exportQs = new URLSearchParams({
    from: filters.fromISO,
    to: filters.toISO,
    locale,
  });
  if (filters.instance !== 'all') exportQs.set('instance', filters.instance);
  if (filters.product !== 'all') exportQs.set('product', filters.product);
  if (filters.agent !== 'all') exportQs.set('agent', filters.agent);
  if (filters.currency) exportQs.set('currency', filters.currency);

  const remove = async (row: HistoryRow) => {
    if (!window.confirm(t('sales.history.confirmDelete'))) return;
    const res = await fetch(`/api/dashboard/sales?id=${row.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('common.genericError'));
      return;
    }
    toast.success(t('sales.history.deleted'));
    onRefresh();
  };

  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h3 className="text-foreground text-sm font-semibold">{t('sales.history.title')}</h3>
          <p className="text-muted-foreground text-[11px]">{t('sales.history.hint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/dashboard/sales/export?${exportQs.toString()}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Download className="size-3.5" />
            {t('sales.history.export')}
          </a>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-[11px]">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {[
                'instance',
                'instanceNumber',
                'lead',
                'client',
                'product',
                'id',
                'value',
                'meta',
                'payment',
                'date',
                'region',
                'actions',
              ].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {t(`sales.history.headers.${h}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="text-muted-foreground px-3 py-10 text-center">
                  {t('sales.history.empty')}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-border/60 hover:bg-muted/20 border-t">
                  <td className="px-3 py-2 whitespace-nowrap">{row.instance_label}</td>
                  <td className="text-muted-foreground px-3 py-2 font-mono whitespace-nowrap">
                    {row.instance_number ?? '—'}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 font-mono">
                    {row.lead_number ?? '—'}
                  </td>
                  <td className="text-foreground px-3 py-2">{row.client_name ?? '—'}</td>
                  <td className="text-muted-foreground px-3 py-2">{row.product_name}</td>
                  <td className="text-muted-foreground px-3 py-2 font-mono" title={row.id}>
                    {row.id.slice(0, 8)}
                  </td>
                  <td className="text-foreground px-3 py-2 font-mono whitespace-nowrap">
                    {money(row.amount, row.currency)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">{row.meta_ref ?? '—'}</td>
                  <td className="text-muted-foreground px-3 py-2 font-mono">{row.payment_id ?? '—'}</td>
                  <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
                      new Date(row.sold_at),
                    )}
                  </td>
                  <td className="text-muted-foreground px-3 py-2">{row.region ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-0.5">
                      {row.conversation_id && (
                        <Link
                          href={`/inbox?c=${row.conversation_id}`}
                          aria-label={t('sales.history.openChat')}
                          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                        >
                          <MessageSquare className="size-3" />
                        </Link>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() => onEdit(row)}
                        aria-label={t('sales.history.edit')}
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive size-6"
                        onClick={() => void remove(row)}
                        aria-label={t('sales.history.delete')}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Diálogo de periodo personalizado
// ------------------------------------------------------------------
function PeriodDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onApply,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: { from: string; to: string };
  onChange: (value: { from: string; to: string }) => void;
  onApply: (value: { from: string; to: string }) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('filters.customTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('filters.customHint')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-muted-foreground mb-1 block text-xs">{t('filters.from')}</Label>
            <Input
              type="date"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className="bg-muted"
            />
          </div>
          <div>
            <Label className="text-muted-foreground mb-1 block text-xs">{t('filters.to')}</Label>
            <Input
              type="date"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className="bg-muted"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => {
              onApply(value);
              onOpenChange(false);
            }}
          >
            {t('filters.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------
// Venta manual / edición
// ------------------------------------------------------------------
function SaleDialog({
  open,
  onOpenChange,
  sale,
  products,
  connections,
  currency,
  accountId,
  onSaved,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: HistoryRow | null;
  products: Product[];
  connections: Connection[];
  currency: string;
  accountId: string | null;
  onSaved: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const supabase = useMemo(
    () => (typeof window === 'undefined' ? null : createClient()),
    [],
  );
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<Array<{ id: string; name: string | null; phone: string }>>([]);
  const [contact, setContact] = useState<{ id: string; name: string | null; phone: string } | null>(null);
  const [productId, setProductId] = useState('');
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(currency);
  const [paymentId, setPaymentId] = useState('');
  const [metaRef, setMetaRef] = useState('');
  const [region, setRegion] = useState('');
  const [instanceId, setInstanceId] = useState('default');
  const [soldAt, setSoldAt] = useState(dateInput(new Date()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (sale) {
      setContact({
        id: '',
        name: sale.client_name,
        phone: '',
      });
      setProductId('');
      setAmount(String(sale.amount));
      setCur(sale.currency || currency);
      setPaymentId(sale.payment_id ?? '');
      setMetaRef(sale.meta_ref ?? '');
      setRegion(sale.region ?? '');
      setInstanceId('default');
      setSoldAt(dateInput(new Date(sale.sold_at)));
    } else {
      setContact(null);
      setContactQuery('');
      setContactResults([]);
      setProductId('');
      setAmount('');
      setCur(currency);
      setPaymentId('');
      setMetaRef('');
      setRegion('');
      setInstanceId('default');
      setSoldAt(dateInput(new Date()));
    }
  }, [open, sale, currency]);

  useEffect(() => {
    if (!open || sale || !accountId || !supabase) return;
    const q = contactQuery.trim();
    if (q.length < 2) {
      setContactResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        const { data } = await supabase
          .from('contacts')
          .select('id, name, phone')
          .eq('account_id', accountId)
          .or(`name.ilike.%${q.replace(/[(),]/g, ' ')}%,phone.ilike.%${q.replace(/[(),]/g, ' ')}%`)
          .limit(8);
        setContactResults((data ?? []) as Array<{ id: string; name: string | null; phone: string }>);
      })();
    }, 300);
    return () => window.clearTimeout(handle);
  }, [contactQuery, open, sale, accountId, supabase]);

  const save = async () => {
    const value = Number(amount);
    if (!sale && !contact) {
      toast.error(t('sales.sale.needContact'));
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      toast.error(t('sales.sale.invalidAmount'));
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        amount: value,
        currency: cur,
        ...(sale && !productId ? {} : { product_id: productId || null }),
        payment_id: paymentId || null,
        meta_ref: metaRef || null,
        region: region || null,
        sold_at: new Date(`${soldAt}T12:00:00`).toISOString(),
      };
      if (!sale) {
        payload.contact_id = contact?.id;
        payload.instance_id = instanceId === 'default' ? null : instanceId;
      }
      payload.id = sale?.id;
      const res = await fetch('/api/dashboard/sales', {
        method: sale ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast.error(t('common.genericError'));
        return;
      }
      toast.success(sale ? t('sales.sale.saved') : t('sales.sale.created'));
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{sale ? t('sales.sale.editTitle') : t('sales.sale.title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('sales.sale.hint')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {sale ? (
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.client')}</Label>
              <Input value={sale.client_name ?? ''} disabled className="bg-muted" />
            </div>
          ) : (
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.client')}</Label>
              <Input
                value={contact ? `${contact.name ?? ''} ${contact.phone}` : contactQuery}
                onChange={(e) => {
                  setContact(null);
                  setContactQuery(e.target.value);
                }}
                className="bg-muted"
                placeholder={t('sales.sale.searchContact')}
              />
              {!contact && contactResults.length > 0 && (
                <ul className="border-border bg-popover mt-1 max-h-40 overflow-y-auto rounded-lg border shadow-lg">
                  {contactResults.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="hover:bg-muted flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"
                        onClick={() => {
                          setContact(c);
                          setContactQuery('');
                          setContactResults([]);
                        }}
                      >
                        <span>{c.name ?? t('sales.sale.noName')}</span>
                        <span className="text-muted-foreground font-mono">{c.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.product')}</Label>
              <Select
                value={productId || 'none'}
                onValueChange={(v) => {
                  const id = v === 'none' ? '' : (v ?? '');
                  setProductId(id);
                  const prod = products.find((p) => p.id === id);
                  if (!sale && prod?.precio && !amount) setAmount(String(prod.precio));
                }}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('sales.sale.noProduct')}</SelectItem>
                  {products
                    .filter((p) => p.activo)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.nombre}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.amount')}</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="bg-muted flex-1"
                />
                <Select value={cur} onValueChange={(v) => setCur(v ?? currency)}>
                  <SelectTrigger className="bg-muted w-[88px] font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[currency, 'MXN', 'USD', 'EUR', 'COP', 'BRL']
                      .filter((v, i, arr) => arr.indexOf(v) === i)
                      .map((c) => (
                        <SelectItem key={c} value={c} className="font-mono">
                          {c}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.paymentId')}</Label>
              <Input value={paymentId} onChange={(e) => setPaymentId(e.target.value)} className="bg-muted font-mono text-xs" />
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.meta')}</Label>
              <Input value={metaRef} onChange={(e) => setMetaRef(e.target.value)} className="bg-muted text-xs" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.region')}</Label>
              <Input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="bg-muted"
                list="mx-states"
              />
              <datalist id="mx-states">
                {MX_STATES.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.date')}</Label>
              <Input type="date" value={soldAt} onChange={(e) => setSoldAt(e.target.value)} className="bg-muted" />
            </div>
          </div>
          {!sale && (
            <div>
              <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.sale.instance')}</Label>
              <Select value={instanceId} onValueChange={(v) => setInstanceId(v ?? 'default')}>
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('sales.sale.defaultInstance')}</SelectItem>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      WhatsApp …{c.phone_number_id.slice(-4)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <RefreshCw className="size-4 animate-spin" />}
            {sale ? t('common.save') : t('sales.sale.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------
// Gasto Meta
// ------------------------------------------------------------------
function AdSpendDialog({
  open,
  onOpenChange,
  from,
  to,
  onSaved,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: string;
  to: string;
  onSaved: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [entries, setEntries] = useState<Array<{ id: string; spent_on: string; amount: number; currency: string; notes: string | null }>>([]);
  const [spentOn, setSpentOn] = useState(from);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      const res = await fetch(`/api/dashboard/ad-spend?${qs.toString()}`);
      const json = await res.json().catch(() => ({}));
      setEntries(json.entries ?? []);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async () => {
    const value = Number(amount);
    if (!spentOn || !Number.isFinite(value) || value < 0) {
      toast.error(t('sales.spend.invalidAmount'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/dashboard/ad-spend', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spent_on: spentOn, amount: value }),
      });
      if (!res.ok) {
        toast.error(t('common.genericError'));
        return;
      }
      toast.success(t('sales.spend.saved'));
      setAmount('');
      await load();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/dashboard/ad-spend?id=${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('common.genericError'));
      return;
    }
    await load();
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sales.spend.title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('sales.spend.hint')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.spend.date')}</Label>
            <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} className="bg-muted" />
          </div>
          <div className="flex-1">
            <Label className="text-muted-foreground mb-1 block text-xs">{t('sales.spend.amount')}</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-muted"
            />
          </div>
          <Button onClick={() => void save()} disabled={saving}>
            {t('common.save')}
          </Button>
        </div>
        <div className="border-border max-h-48 overflow-y-auto rounded-lg border">
          {loading ? (
            <p className="text-muted-foreground p-3 text-xs">{t('common.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground p-3 text-xs">{t('sales.spend.empty')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="font-mono">{e.spent_on}</span>
                  <span>{e.amount.toFixed(2)} {e.currency}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive size-6"
                    onClick={() => void remove(e.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
