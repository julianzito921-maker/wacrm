"use client";

/**
 * Avisos de validación (`validateFlowForActivation`). Antes era una
 * franja fija abajo del editor; ahora es un botón con contador en la
 * barra superior + globos en cada nodo del lienzo.
 *
 * Node-scoped issues are clickable: tapping one calls
 * `requestFlash(node_key)` on the editor context. List view's
 * useEffect on `flashKey` expands + scrolls + flashes the row;
 * canvas view's useEffect pans the viewport + flashes the card.
 * Both views read the same flashKey so the panel doesn't need
 * per-view plumbing.
 *
 * Trigger-scoped issues are NOT clickable from canvas — trigger
 * config is a list-only panel (it's a flat form, not a graph
 * concept). User can switch to List to address them.
 */

import { useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/flows/validate";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFlowEditor } from "./flow-editor-state";

/**
 * Botón compacto de la barra superior: un círculo con el número de
 * avisos. Al tocarlo abre la lista; cada aviso lleva a su nodo. Los
 * avisos también se marcan en cada nodo del lienzo (globo ámbar/rojo),
 * así que ya no hace falta la franja fija de abajo.
 */
export function ValidationButton({ onJump }: { onJump?: (key: string) => void }) {
  const { issues, requestFlash } = useFlowEditor();
  const t = useTranslations("Flows.validation");
  const [abierto, setAbierto] = useState(false);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const ir = (key: string) => {
    setAbierto(false);
    (onJump ?? requestFlash)(key);
  };

  const tono =
    errors.length > 0
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : warnings.length > 0
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger
        title={
          issues.length === 0
            ? t("noIssues")
            : t("summary", { errorCount: errors.length, warningCount: warnings.length })
        }
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] font-semibold transition-colors hover:brightness-125",
          tono,
        )}
      >
        {issues.length === 0 ? (
          <CircleCheck className="h-3.5 w-3.5" />
        ) : (
          <CircleAlert className="h-3.5 w-3.5" />
        )}
        {errors.length > 0 && <span>{errors.length}</span>}
        {errors.length > 0 && warnings.length > 0 && <span className="opacity-50">·</span>}
        {warnings.length > 0 && <span className={cn(errors.length > 0 && "text-amber-300")}>{warnings.length}</span>}
        <span className="hidden xl:inline">{t("button")}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-xs text-muted-foreground">
          {issues.length === 0 ? (
            <CircleCheck className="h-4 w-4 text-emerald-400" />
          ) : (
            <CircleAlert className={cn("h-4 w-4", errors.length > 0 ? "text-red-400" : "text-amber-400")} />
          )}
          {issues.length === 0
            ? t("noIssues")
            : t("summary", { errorCount: errors.length, warningCount: warnings.length })}
        </div>
        {issues.length > 0 && (
          <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto p-1.5">
            {[...errors, ...warnings].map((i, ix) => (
              <IssueLine key={ix} issue={i} onJump={ir} t={t} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Exported so the per-node card (list view) and the trigger panel
 * can render the same "icon + node key chip + message" formatting
 * for their own per-row issue lists without re-implementing the
 * tone / icon / accessibility logic.
 */
export function IssueLine({
  issue,
  onJump,
  t,
}: {
  issue: ValidationIssue;
  onJump?: (key: string) => void;
  t?: ReturnType<typeof useTranslations>;
}) {
  const tone =
    issue.severity === "error" ? "text-red-300" : "text-amber-300";
  const iconTone =
    issue.severity === "error" ? "text-red-400" : "text-amber-400";
  const body = (
    <>
      <CircleAlert className={cn("mt-0.5 h-3 w-3 shrink-0", iconTone)} />
      <span className="min-w-0 flex-1">
        {issue.node_key && (
          <code className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            {issue.node_key}
          </code>
        )}
        {issue.message}
      </span>
    </>
  );

  // Only node-scoped issues can jump; trigger-scoped issues have no
  // destination (the trigger panel is list-only and already at the
  // top of that view).
  if (issue.node_key && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(issue.node_key!)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60",
          tone,
        )}
        aria-label={t ? t("jumpToNode", { key: issue.node_key! }) : `Jump to node ${issue.node_key}`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1 text-xs",
        tone,
      )}
    >
      {body}
    </div>
  );
}
