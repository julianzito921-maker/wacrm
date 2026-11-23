"use client";

import { useEffect, useState } from "react";
import { Loader2, Phone, ShieldCheck } from "lucide-react";
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

interface Conexion {
  id: string;
  name: string;
  phone_number: string | null;
  bridge_url: string;
  bridge_enabled: boolean;
  has_bridge_secret: boolean;
  calling_status: Record<string, unknown> | null;
  checked_at: string | null;
}

interface Verificacion {
  available: boolean;
  country: string | null;
  reason: string;
  detail?: string | null;
}

export function CallingSettings() {
  const t = useTranslations("Settings.calling");
  const [conexiones, setConexiones] = useState<Conexion[]>([]);
  const [secretos, setSecretos] = useState<Record<string, string>>({});
  const [verificando, setVerificando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Record<string, Verificacion>>({});
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState<string | null>(null);

  const cargar = async () => {
    setCargando(true);
    try {
      const res = await fetch("/api/settings/calling");
      const json = (await res.json()) as { connections?: Conexion[] };
      if (!res.ok) throw new Error();
      setConexiones(json.connections ?? []);
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

  const guardar = async (c: Conexion) => {
    setGuardando(c.id);
    try {
      const res = await fetch("/api/settings/calling", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: c.id,
          bridge_url: c.bridge_url,
          bridge_secret: secretos[c.id] ?? "",
          bridge_enabled: c.bridge_enabled,
        }),
      });
      if (!res.ok) throw new Error();
      setSecretos((s) => ({ ...s, [c.id]: "" }));
      toast.success(t("saved"));
      await cargar();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setGuardando(null);
    }
  };

  const verificar = async (id: string) => {
    setVerificando(id);
    try {
      const res = await fetch(`/api/connections/${id}/calling-check`, {
        method: "POST",
      });
      const json = (await res.json()) as Verificacion & { error?: string };
      if (!res.ok) throw new Error(json.error || "error");
      setResultado((r) => ({ ...r, [id]: json }));
      await cargar();
    } catch {
      toast.error(t("checkFailed"));
    } finally {
      setVerificando(null);
    }
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Phone className="size-4 text-primary" />
            {t("cardTitle")}
          </CardTitle>
          <CardDescription>{t("cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cargando ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : conexiones.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noConnections")}</p>
          ) : (
            conexiones.map((c) => {
              const r = resultado[c.id];
              return (
                <div key={c.id} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {c.phone_number}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void verificar(c.id)}
                      disabled={verificando === c.id}
                    >
                      {verificando === c.id ? (
                        <Loader2 className="mr-1 size-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-1 size-3.5" />
                      )}
                      {t("check")}
                    </Button>
                  </div>

                  {r ? (
                    <p
                      className={
                        "text-[10px] " +
                        (r.available ? "text-emerald-500" : "text-amber-500")
                      }
                    >
                      {r.available
                        ? t("available")
                        : r.detail || t(`reason.${r.reason}`)}
                    </p>
                  ) : null}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      value={c.bridge_url}
                      onChange={(e) =>
                        setConexiones((prev) =>
                          prev.map((x) =>
                            x.id === c.id ? { ...x, bridge_url: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder={t("bridgeUrl")}
                      className="bg-muted"
                    />
                    <Input
                      type="password"
                      value={secretos[c.id] ?? ""}
                      onChange={(e) =>
                        setSecretos((s) => ({ ...s, [c.id]: e.target.value }))
                      }
                      placeholder={
                        c.has_bridge_secret ? t("secretSaved") : t("bridgeSecret")
                      }
                      className="bg-muted"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={c.bridge_enabled}
                        onCheckedChange={(v) =>
                          setConexiones((prev) =>
                            prev.map((x) =>
                              x.id === c.id ? { ...x, bridge_enabled: v } : x,
                            ),
                          )
                        }
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {t("bridgeEnabled")}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void guardar(c)}
                      disabled={guardando === c.id}
                    >
                      {guardando === c.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : null}
                      {t("save")}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </section>
  );
}
