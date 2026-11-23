"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

interface Credencial {
  id: string;
  name: string;
  created_at?: string;
}

export function FlowCredentialsSettings() {
  const t = useTranslations("Settings.flowCredentials");
  const [credenciales, setCredenciales] = useState<Credencial[]>([]);
  const [nombre, setNombre] = useState("");
  const [valor, setValor] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    setCargando(true);
    try {
      const res = await fetch("/api/settings/flow-credentials");
      const json = (await res.json()) as { credentials?: Credencial[] };
      if (!res.ok) throw new Error();
      setCredenciales(json.credentials ?? []);
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

  const agregar = async () => {
    if (!nombre.trim() || !valor.trim()) return;
    setGuardando(true);
    try {
      const res = await fetch("/api/settings/flow-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nombre, value: valor }),
      });
      if (!res.ok) throw new Error();
      setNombre("");
      setValor("");
      toast.success(t("created"));
      await cargar();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (id: string) => {
    try {
      const res = await fetch(`/api/settings/flow-credentials/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      setCredenciales((prev) => prev.filter((c) => c.id !== id));
      toast.success(t("deleted"));
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <KeyRound className="size-4 text-primary" />
            {t("cardTitle")}
          </CardTitle>
          <CardDescription>{t("cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {cargando ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : (
            credenciales.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 p-2"
              >
                <span className="font-mono text-xs">{c.name}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => void borrar(c.id)}
                  aria-label={t("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}

          <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
            <Input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="bg-muted font-mono text-xs"
            />
            <Input
              type="password"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder={t("valuePlaceholder")}
              className="bg-muted font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            onClick={() => void agregar()}
            disabled={guardando || !nombre.trim() || !valor.trim()}
          >
            {guardando ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("add")}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
