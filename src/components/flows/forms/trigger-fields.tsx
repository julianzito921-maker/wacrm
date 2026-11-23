"use client";

/**
 * Disparador del flujo: tipo + palabras clave.
 *
 * Lo usan el panel «Disparador» de la vista Lista y el bloque
 * «Inicio / Disparador» del lienzo. Los dos editan el mismo
 * `trigger_type` / `trigger_config` del estado del editor, así que nunca
 * se desincronizan y el motor no cambia (lee el disparador del flujo).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFlowEditor, type BuilderState } from "../flow-editor-state";

/**
 * Comma-separated keyword entry. Keeps a local draft string so the
 * comma (and trailing space) the user types survive until they're done
 * — parsing into the keywords array on every keystroke stripped the
 * trailing comma the instant it was typed, making it impossible to
 * start a second keyword (issue #234). We commit on blur / Enter, then
 * re-display the cleaned, rejoined form. Seeded once on mount; the
 * component unmounts/remounts when the trigger type changes, so the
 * seed stays in sync. Mirrors the automations builder's KeywordMatchConfig.
 */
function KeywordsInput({
  keywords,
  onChange,
  placeholder,
}: {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(keywords.join(", "));

  function commit() {
    const parsed = draft
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    setDraft(parsed.join(", "));
    onChange(parsed);
  }

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      placeholder={placeholder}
      className="bg-muted"
    />
  );
}

export function TriggerFields({ layout = "grid" }: { layout?: "grid" | "stack" }) {
  const t = useTranslations("Flows.builder");
  const { state, setState } = useFlowEditor();
  return (
    <div className={layout === "grid" ? "grid grid-cols-1 gap-3 md:grid-cols-2" : "flex flex-col gap-3"}>
      <div>
        <label className="text-muted-foreground mb-1 block text-xs">{t("whenLabel")}</label>
        <Select
          value={state.trigger_type}
          onValueChange={(v) =>
            setState((s) => ({
              ...s,
              trigger_type: v as BuilderState["trigger_type"],
              trigger_config: v === "keyword" ? { keywords: [] } : {},
            }))
          }
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="keyword">{t("triggerKeywordTitle")}</SelectItem>
            <SelectItem value="any_message">{t("triggerAnyMessageTitle")}</SelectItem>
            <SelectItem value="first_inbound_message">{t("triggerFirstInboundTitle")}</SelectItem>
            <SelectItem value="manual">{t("triggerManualTitle")}</SelectItem>
          </SelectContent>
        </Select>
        {state.trigger_type === "any_message" && (
          <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
            {t("triggerAnyMessageHint")}
          </p>
        )}
      </div>
      {state.trigger_type === "keyword" && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs">{t("keywordsLabel")}</label>
          <KeywordsInput
            keywords={
              Array.isArray(state.trigger_config.keywords)
                ? (state.trigger_config.keywords as string[])
                : []
            }
            onChange={(keywords) =>
              setState((s) => ({
                ...s,
                trigger_config: { ...s.trigger_config, keywords },
              }))
            }
            placeholder={t("keywordsPlaceholder")}
          />
        </div>
      )}
    </div>
  );
}
