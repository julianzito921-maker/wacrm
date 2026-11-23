"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AI_MEDIA_EDGE_VOICES } from "@/lib/flows/types";
import { SettingsPanelHead } from "./settings-panel-head";

interface Config {
  image_provider: string;
  image_model: string;
  audio_provider: string;
  audio_model: string;
  default_voice: string;
  has_image_api_key: boolean;
  has_audio_api_key: boolean;
}

export function AiMediaSettings() {
  const t = useTranslations("Settings.aiMedia");
  const [config, setConfig] = useState<Config | null>(null);
  const [imageKey, setImageKey] = useState("");
  const [audioKey, setAudioKey] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    setCargando(true);
    try {
      const res = await fetch("/api/settings/ai-media");
      const json = (await res.json()) as { config?: Config };
      if (!res.ok || !json.config) throw new Error();
      setConfig(json.config);
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

  const guardar = async () => {
    if (!config) return;
    setGuardando(true);
    try {
      const res = await fetch("/api/settings/ai-media", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...config,
          image_api_key: imageKey,
          audio_api_key: audioKey,
        }),
      });
      if (!res.ok) throw new Error();
      setImageKey("");
      setAudioKey("");
      toast.success(t("saved"));
      await cargar();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Sparkles className="size-4 text-primary" />
            {t("cardTitle")}
          </CardTitle>
          <CardDescription>{t("cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cargando || !config ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t("imageProvider")}
                  </label>
                  <Select
                    value={config.image_provider}
                    onValueChange={(v) => setConfig({ ...config, image_provider: String(v) })}
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue>{config.image_provider}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pollinations">Pollinations (gratis)</SelectItem>
                      <SelectItem value="together">Together / FLUX</SelectItem>
                      <SelectItem value="flux">FLUX</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t("imageModel")}
                  </label>
                  <Input
                    value={config.image_model}
                    onChange={(e) => setConfig({ ...config, image_model: e.target.value })}
                    className="bg-muted font-mono text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t("imageKey")} {config.has_image_api_key ? `· ${t("saved")}` : ""}
                </label>
                <Input
                  type="password"
                  value={imageKey}
                  onChange={(e) => setImageKey(e.target.value)}
                  placeholder={t("keyPlaceholder")}
                  className="bg-muted"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t("audioProvider")}
                  </label>
                  <Select
                    value={config.audio_provider}
                    onValueChange={(v) => setConfig({ ...config, audio_provider: String(v) })}
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue>{config.audio_provider}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="edge">Edge-TTS (gratis)</SelectItem>
                      <SelectItem value="openai">OpenAI TTS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t("voice")}
                  </label>
                  <Select
                    value={config.default_voice}
                    onValueChange={(v) => setConfig({ ...config, default_voice: String(v) })}
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue>{config.default_voice}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {AI_MEDIA_EDGE_VOICES.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}
                        </SelectItem>
                      ))}
                      <SelectItem value="alloy">OpenAI · alloy</SelectItem>
                      <SelectItem value="nova">OpenAI · nova</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t("audioKey")} {config.has_audio_api_key ? `· ${t("saved")}` : ""}
                </label>
                <Input
                  type="password"
                  value={audioKey}
                  onChange={(e) => setAudioKey(e.target.value)}
                  placeholder={t("keyPlaceholder")}
                  className="bg-muted"
                />
              </div>

              <Button onClick={() => void guardar()} disabled={guardando}>
                {guardando ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("save")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
