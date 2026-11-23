"use client";

import { useEffect, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { SettingsPanelHead } from "./settings-panel-head";

interface Horario {
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
}

const DIAS = [
  [1, "L"],
  [2, "M"],
  [3, "M"],
  [4, "J"],
  [5, "V"],
  [6, "S"],
  [7, "D"],
] as const;

export function BusinessHoursSettings() {
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations("Settings.businessHours");
  const [timezone, setTimezone] = useState("America/Mexico_City");
  const [horario, setHorario] = useState<Horario>({
    enabled: false,
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
  });
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelado = false;
    (async () => {
      const { data, error } = await createClient()
        .from("accounts")
        .select("timezone, business_hours")
        .eq("id", accountId)
        .maybeSingle();
      if (cancelado) return;
      setCargando(false);
      if (error || !data) {
        toast.error(t("loadFailed"));
        return;
      }
      const d = data as {
        timezone?: string | null;
        business_hours?: Partial<Horario> | null;
      };
      setTimezone(d.timezone || "America/Mexico_City");
      setHorario({
        enabled: d.business_hours?.enabled === true,
        days: d.business_hours?.days ?? [1, 2, 3, 4, 5],
        start: d.business_hours?.start ?? "09:00",
        end: d.business_hours?.end ?? "18:00",
      });
    })();
    return () => {
      cancelado = true;
    };
  }, [accountId, t]);

  const guardar = async () => {
    if (!accountId) return;
    setGuardando(true);
    const { error } = await createClient()
      .from("accounts")
      .update({ timezone, business_hours: horario })
      .eq("id", accountId);
    setGuardando(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(t("saved"));
  };

  const disabled = !canEditSettings || profileLoading || cargando;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Clock className="size-4 text-primary" />
            {t("cardTitle")}
          </CardTitle>
          <CardDescription>{t("cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("timezone")}</label>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={disabled}
                placeholder="America/Mexico_City"
                className="bg-muted font-mono text-xs"
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">{t("enabled")}</span>
              <Switch
                checked={horario.enabled}
                onCheckedChange={(v) => setHorario((h) => ({ ...h, enabled: v }))}
                disabled={disabled}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("days")}
            </label>
            <div className="flex gap-1">
              {DIAS.map(([d, label]) => {
                const activo = horario.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      setHorario((h) => ({
                        ...h,
                        days: activo
                          ? h.days.filter((x) => x !== d)
                          : [...h.days, d].sort(),
                      }))
                    }
                    className={
                      "size-8 rounded-md border text-[11px] " +
                      (activo
                        ? "border-primary bg-primary-soft text-primary"
                        : "border-border text-muted-foreground")
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("from")}</label>
              <Input
                type="time"
                value={horario.start}
                onChange={(e) => setHorario((h) => ({ ...h, start: e.target.value }))}
                disabled={disabled}
                className="bg-muted"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("to")}</label>
              <Input
                type="time"
                value={horario.end}
                onChange={(e) => setHorario((h) => ({ ...h, end: e.target.value }))}
                disabled={disabled}
                className="bg-muted"
              />
            </div>
          </div>

          <Button onClick={() => void guardar()} disabled={disabled || guardando}>
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("save")}
          </Button>
          {!canEditSettings ? (
            <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
