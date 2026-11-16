-- ============================================================
-- 064_salida_unica_mensajes.sql
--
-- FASE 1 de la capa segura de mensajería (pedido de Julián,
-- 2026-11-16). Dos cosas, ninguna cambia comportamiento:
--
--   1. `outbound_message_log` — una fila por CADA intento de envío
--      saliente, venga de donde venga (flujo, automatización, IA,
--      envío manual, difusión o recordatorio de ventas). Guarda el
--      motivo, el origen, el mensaje, la respuesta de Meta, el error
--      y cuánto tardó. Es lo que permite responder «¿por qué se
--      mandó esto?» sin adivinar.
--
--   2. En `messages`: `error_code`, `error_message` y
--      `attempt_number`. Hasta hoy los rechazos de Meta (por ejemplo
--      131047, mensaje fuera de la ventana de 24 h) NO se guardaban
--      en ningún lado: el envío fallaba en silencio y no había forma
--      de auditar cuántos ni por qué.
--
-- Nada de esto autoriza, bloquea ni retrasa un envío: sólo registra.
-- Las reglas (ventana, límites, dedupe, cola) llegan en la fase 2.
-- ============================================================

-- ---------- 1. mensajes: por qué falló ----------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN messages.error_code IS
  'Código de error de Meta (p. ej. 131047 = fuera de la ventana de 24 h).';
COMMENT ON COLUMN messages.error_message IS
  'Mensaje de error de Meta tal cual, para auditoría.';
COMMENT ON COLUMN messages.attempt_number IS
  'Número de intento de envío (1 = el primero).';

-- ---------- 2. registro de salida ----------
CREATE TABLE IF NOT EXISTS outbound_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Fila creada en `messages`, cuando el envío llegó a guardarse.
  message_row_id UUID REFERENCES messages(id) ON DELETE SET NULL,

  -- Qué se mandó
  message_type TEXT NOT NULL,
  content_preview TEXT,
  content_hash TEXT,

  -- Por qué y desde dónde (auditoría)
  reason TEXT,
  source TEXT NOT NULL,
  workflow_id UUID,
  workflow_node_key TEXT,
  source_event_id TEXT,
  idempotency_key TEXT,

  -- Cómo salió
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed')),
  whatsapp_message_id TEXT,
  api_response JSONB,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

-- Un mismo envío no puede registrarse dos veces: la clave la manda
-- quien envía y, si llega repetida, no se inserta otra fila.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_message_log_idempotency_idx
  ON outbound_message_log (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_message_log_account_time_idx
  ON outbound_message_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_message_log_conversation_idx
  ON outbound_message_log (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_message_log_contact_idx
  ON outbound_message_log (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_message_log_status_idx
  ON outbound_message_log (account_id, status, created_at DESC);

COMMENT ON TABLE outbound_message_log IS
  'Registro de cada envío saliente: qué, a quién, cuándo, por qué, '
  'por dónde salió y qué dijo Meta. Fase 1 de la capa de mensajería.';

ALTER TABLE outbound_message_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_message_log_select ON outbound_message_log;
CREATE POLICY outbound_message_log_select ON outbound_message_log
  FOR SELECT USING (is_account_member(account_id));

-- El registro lo escribe el servidor (service role). Un miembro de la
-- cuenta puede leerlo desde Actividad, pero no editarlo ni borrarlo:
-- es evidencia de auditoría.
DROP POLICY IF EXISTS outbound_message_log_insert ON outbound_message_log;
CREATE POLICY outbound_message_log_insert ON outbound_message_log
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
