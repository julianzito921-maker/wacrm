-- ============================================================
-- CONVERSATION NOTES (notas internas entre agentes)
--
-- Notas privadas del equipo dentro de un hilo. NUNCA salen por
-- WhatsApp: no viven en `messages`, no tocan unread_count, no
-- disparan el webhook ni la salida única. Solo agentes de la
-- cuenta las ven (RLS por is_account_member).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Tenancy: la cuenta dueña del hilo. NOT NULL desde su creación.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Autor de la nota. Audit + etiqueta visual en el hilo.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conversation
  ON conversation_notes(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_account
  ON conversation_notes(account_id);

ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;

-- Todos los miembros de la cuenta leen las notas del equipo.
DROP POLICY IF EXISTS conversation_notes_select ON conversation_notes;
CREATE POLICY conversation_notes_select ON conversation_notes FOR SELECT
  USING (is_account_member(account_id));

-- Los miembros de la cuenta pueden crear notas. El INSERT lo hace el
-- servidor (ruta /api/conversations/[id]/notes) resolviendo la cuenta
-- desde la sesión, así que esta política es la red de seguridad: un
-- cliente nunca puede escribir una nota en una cuenta ajena.
DROP POLICY IF EXISTS conversation_notes_insert ON conversation_notes;
CREATE POLICY conversation_notes_insert ON conversation_notes FOR INSERT
  WITH CHECK (is_account_member(account_id));

-- El autor puede borrar su propia nota (solo la suya, no las del equipo).
DROP POLICY IF EXISTS conversation_notes_delete ON conversation_notes;
CREATE POLICY conversation_notes_delete ON conversation_notes FOR DELETE
  USING (auth.uid() = user_id AND is_account_member(account_id));

-- Realtime: el frontend escucha INSERT/DELETE para refrescar el panel
-- de notas del hilo en vivo, igual que con messages/conversations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_notes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_notes;
  END IF;
END $$;