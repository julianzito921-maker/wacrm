"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import { StickyNote, Trash2, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationNote } from "@/types";
import { toast } from "sonner";
import { format } from "date-fns";

interface NoteAuthor {
  user_id: string
  full_name: string | null
  avatar_url?: string | null
}

interface NoteRow extends Omit<ConversationNote, 'author'> {
  author?: NoteAuthor | null
}

/**
 * Notas internas del equipo dentro de un hilo. No son mensajes: nunca
 * salen por WhatsApp, no tocan unread_count ni last_message_text, y no
 * disparan automatizaciones. Las ve cualquier miembro de la cuenta;
 * solo su autor puede borrarlas (RLS, migración 076).
 *
 * Se reciben en vivo vía Realtime en `conversation_notes`.
 */
export function NotesPanel({ conversationId }: { conversationId: string }) {
  const t = useTranslations("Inbox.notesPanel");
  const { user, accountId } = useAuth();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("conversation_notes")
      .select("*, author:profiles!conversation_notes_user_id_fkey(user_id, full_name, avatar_url)")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[notes] load failed:", error.message);
    } else {
      setNotes((data as NoteRow[]) ?? []);
    }
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();

    // Initial fetch + realtime. The channel filters to this conversation,
    // so INSERT (team member adds a note) and DELETE (author removes one)
    // flow straight into the list without full refetches.
    const channel = supabase
      .channel(`conversation-notes-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_notes",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          if (!alive) return;
          const row = payload.new as NoteRow;
          if (!row.author) {
            // Fetch the author display so the bubble shows a name.
            const { data: author } = await createClient()
              .from("profiles")
              .select("user_id, full_name, avatar_url")
              .eq("user_id", row.user_id)
              .maybeSingle();
            if (alive && author) row.author = author as NoteRow["author"];
          }
          setNotes((prev) => [row, ...prev.filter((n) => n.id !== row.id)]);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "conversation_notes",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          if (!alive) return;
          const deleted = payload.old as { id: string };
          setNotes((prev) => prev.filter((n) => n.id !== deleted.id));
        },
      )
      .subscribe();

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadNotes();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [conversationId, loadNotes]);

  const handleAdd = useCallback(async () => {
    const text = draft.trim();
    if (!text || !accountId || !user?.id || sending) return;
    setSending(true);
    const supabase = createClient();
    const { error } = await supabase.from("conversation_notes").insert({
      conversation_id: conversationId,
      account_id: accountId,
      user_id: user.id,
      note_text: text,
    });
    setSending(false);
    if (error) {
      toast.error(t("addFailed"), { description: error.message });
      return;
    }
    setDraft("");
    inputRef.current?.focus();
  }, [draft, accountId, user, sending, conversationId, t]);

  const handleDelete = useCallback(
    async (noteId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("conversation_notes")
        .delete()
        .eq("id", noteId);
      if (error) {
        toast.error(t("deleteFailed"), { description: error.message });
      }
      // Realtime remueve la fila; si el canal tardara, quitarla local ya.
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    },
    [t],
  );

  return (
    <div className="border-t border-border bg-card/90 px-3 py-2 sm:px-4">
      <div className="mb-1 flex items-center gap-1.5">
        <StickyNote className="h-3 w-3 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("title")}
        </span>
        <span className="text-[10px] text-muted-foreground">({notes.length})</span>
      </div>

      <div className="flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("loading")}
          </div>
        ) : notes.length === 0 ? (
          <p className="py-1 text-[11px] text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {notes.map((note) => (
              <div
                key={note.id}
                className="flex items-start gap-2 rounded-md bg-muted/50 px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    {note.author?.full_name && (
                      <span className="truncate text-[10px] font-semibold text-primary">
                        {note.author.full_name}
                      </span>
                    )}
                    <span className="shrink-0 text-[9px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, HH:mm")}
                    </span>
                  </div>
                  <p className="break-words text-[11px] text-foreground">
                    {note.note_text}
                  </p>
                </div>
                {note.user_id === user?.id && (
                  <button
                    type="button"
                    onClick={() => void handleDelete(note.id)}
                    aria-label={t("delete")}
                    title={t("delete")}
                    className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleAdd();
            }
          }}
          placeholder={t("placeholder")}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={!draft.trim() || sending}
          aria-label={t("add")}
          title={t("add")}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            draft.trim()
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "cursor-not-allowed bg-muted text-muted-foreground",
          )}
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}