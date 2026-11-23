"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

interface Proveedor {
  provider: string;
  has_webhook_secret: boolean;
  has_api_key: boolean;
  config: Record<string, unknown>;
  active: boolean;
  webhook_url: string;
}

interface SesionPendiente {
  id: string;
  provider: string;
  reference: string;
  amount: number;
  currency: string;
  created_at: string;
  expires_at: string | null;
  contact?: { name?: string | null; phone?: string | null; email?: string | null } | null;
}

const NOMBRES: Record<string, string> = {
  stripe: "Stripe",
  mercadopago: "Mercado Pago",
  hotmart: "Hotmart",
  whop: "Whop",
  spei: "SPEI",
};

export function PaymentsSettings() {
  const t = useTranslations("Settings.payments");
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [pendientes, setPendientes] = useState<SesionPendiente[]>([]);
  const [secretos, setSecretos] = useState<Record<string, string>>({});
  const [apis, setApis] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState<string | null>(null);

  const cargar = async () => {
    setCargando(true);
    try {
      const [p, s] = await Promise.all([
        fetch("/api/settings/payments").then((r) => r.json()),
        fetch("/api/flows/payments").then((r) => r.json()),
      ]);
      setProveedores((p.providers as Proveedor[] | undefined) ?? []);
      setPendientes((s.sessions as SesionPendiente[] | undefined) ?? []);
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guardar = async (provider: string) => {
    setGuardando(provider);
    try {
      const res = await fetch("/api/settings/payments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          webhook_secret: secretos[provider] ?? "",
          api_key: apis[provider] ?? "",
          active: proveedores.find((p) => p.provider === provider)?.active ?? true,
        }),
      });
      if (!res.ok) throw new Error();
      setSecretos((s) => ({ ...s, [provider]: "" }));
      setApis((s) => ({ ...s, [provider]: "" }));
      toast.success(t("saved"));
      await cargar();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setGuardando(null);
    }
  };

  const confirmar = async (id: string, status: "approved" | "rejected") => {
    try {
      const res = await fetch(`/api/flows/payments/${id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error();
      toast.success(status === "approved" ? t("approved") : t("rejected"));
      await cargar();
    } catch {
      toast.error(t("confirmFailed"));
    }
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Wallet className="size-4 text-primary" />
            {t("providersTitle")}
          </CardTitle>
          <CardDescription>{t("providersDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cargando ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : (
            proveedores.map((p) => (
              <div key={p.provider} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{NOMBRES[p.provider] ?? p.provider}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {p.has_webhook_secret ? t("secretSaved") : t("secretMissing")}
                  </span>
                </div>
                <Input
                  value={p.webhook_url}
                  readOnly
                  className="bg-muted font-mono text-[10px]"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="password"
                    value={secretos[p.provider] ?? ""}
                    onChange={(e) =>
                      setSecretos((s) => ({ ...s, [p.provider]: e.target.value }))
                    }
                    placeholder={
                      p.provider === "hotmart"
                        ? t("hottokPlaceholder")
                        : t("webhookSecretPlaceholder")
                    }
                    className="bg-muted"
                  />
                  <Input
                    type="password"
                    value={apis[p.provider] ?? ""}
                    onChange={(e) =>
                      setApis((s) => ({ ...s, [p.provider]: e.target.value }))
                    }
                    placeholder={t("apiKeyPlaceholder")}
                    className="bg-muted"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={p.active}
                      onCheckedChange={() => undefined}
                      disabled
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {p.active ? t("active") : t("inactive")}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void guardar(p.provider)}
                    disabled={guardando === p.provider}
                  >
                    {guardando === p.provider ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    {t("save")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t("pendingTitle")}</CardTitle>
          <CardDescription>{t("pendingDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => void cargar()}>
            <RefreshCw className="mr-1 size-3.5" />
            {t("refresh")}
          </Button>
          {pendientes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pendingEmpty")}</p>
          ) : (
            pendientes.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {NOMBRES[p.provider] ?? p.provider} · {p.amount} {p.currency}
                  </div>
                  <div className="text-muted-foreground">
                    {p.contact?.name || p.contact?.phone || p.contact?.email || p.reference}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void confirmar(p.id, "approved")}
                  >
                    <Check className="mr-1 size-3.5 text-emerald-500" />
                    {t("markPaid")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void confirmar(p.id, "rejected")}
                  >
                    <X className="mr-1 size-3.5 text-red-500" />
                    {t("markRejected")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
