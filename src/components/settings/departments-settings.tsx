"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Loader2, Plus, Trash2 } from "lucide-react";
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

interface Departamento {
  id: string;
  name: string;
  color: string;
  is_active: boolean;
  sort_order: number;
}

const COLORES = ["#6C47FF", "#0EA5E9", "#F59E0B", "#22c55e", "#ec4899", "#6366f1"];

export function DepartmentsSettings() {
  const { accountId, canEditSettings } = useAuth();
  const t = useTranslations("Settings.departments");
  const supabase = useMemo(() => createClient(), []);
  const [filas, setFilas] = useState<Departamento[]>([]);
  const [nombre, setNombre] = useState("");
  const [color, setColor] = useState(COLORES[0]);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    if (!accountId) return;
    setCargando(true);
    const { data, error } = await supabase
      .from("departments")
      .select("id, name, color, is_active, sort_order")
      .eq("account_id", accountId)
      .order("sort_order");
    setCargando(false);
    if (error) {
      toast.error(t("loadFailed"));
      return;
    }
    setFilas((data as Departamento[] | null) ?? []);
  };

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const agregar = async () => {
    if (!accountId || !nombre.trim()) return;
    setGuardando(true);
    const { error } = await supabase.from("departments").insert({
      account_id: accountId,
      name: nombre.trim(),
      color,
      sort_order: filas.length,
    });
    setGuardando(false);
    if (error) {
      toast.error(error.code === "23505" ? t("duplicate") : t("saveFailed"));
      return;
    }
    setNombre("");
    toast.success(t("created"));
    await cargar();
  };

  const actualizar = async (id: string, patch: Partial<Departamento>) => {
    const { error } = await supabase
      .from("departments")
      .update(patch)
      .eq("id", id)
      .eq("account_id", accountId!);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const borrar = async (id: string) => {
    const { error } = await supabase
      .from("departments")
      .delete()
      .eq("id", id)
      .eq("account_id", accountId!);
    if (error) {
      toast.error(t("deleteFailed"));
      return;
    }
    setFilas((prev) => prev.filter((f) => f.id !== id));
    toast.success(t("deleted"));
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Building2 className="size-4 text-primary" />
            {t("listTitle")}
          </CardTitle>
          <CardDescription>{t("listDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {cargando ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : (
            filas.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2"
              >
                <input
                  type="color"
                  value={f.color}
                  onChange={(e) => void actualizar(f.id, { color: e.target.value })}
                  disabled={!canEditSettings}
                  className="size-8 cursor-pointer rounded border-0 bg-transparent"
                  aria-label={t("color")}
                />
                <Input
                  value={f.name}
                  onChange={(e) =>
                    setFilas((prev) =>
                      prev.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)),
                    )
                  }
                  onBlur={(e) => void actualizar(f.id, { name: e.target.value.trim() })}
                  disabled={!canEditSettings}
                  className="bg-background"
                />
                <Switch
                  checked={f.is_active}
                  onCheckedChange={(v) => void actualizar(f.id, { is_active: v })}
                  disabled={!canEditSettings}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={!canEditSettings}
                  onClick={() => void borrar(f.id)}
                  aria-label={t("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}

          {canEditSettings ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="size-9 cursor-pointer rounded border-0 bg-transparent"
                aria-label={t("color")}
              />
              <Input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="min-w-[180px] flex-1 bg-muted"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void agregar();
                }}
              />
              <Button onClick={() => void agregar()} disabled={guardando || !nombre.trim()}>
                {guardando ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {t("add")}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
