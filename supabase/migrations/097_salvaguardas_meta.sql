-- ============================================================
-- 097_salvaguardas_meta.sql
--
-- Blindaje contra baneos y cumplimiento Cloud API 2026:
--   1. Opt-out global y opt-out de marketing.
--   2. Salud de conexiones (account_update, quality, límites).
--   3. Límite de portafolio 2026 y display_phone_number.
--   4. Estados skipped para errores 131049/131050 y warm-up.
--   5. Warm-up diario por conexión con reserva atómica.
--   6. Pausa de broadcasts y notificaciones de salud.
--
-- Requiere 089 y 095/096. Idempotente.
-- ============================================================

-- ============================================================
-- 1. CONTACTOS: opt-out global y opt-out de marketing
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketing_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS opt_out_source TEXT,
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marketing_opt_out_source TEXT;

UPDATE contacts
SET opted_out = TRUE
WHERE opt_out_at IS NOT NULL AND opted_out = FALSE;

UPDATE contacts
SET marketing_opted_out = TRUE,
    marketing_opt_out_at = COALESCE(marketing_opt_out_at, opt_out_at)
WHERE opt_out_at IS NOT NULL AND marketing_opted_out = FALSE;

CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts (account_id) WHERE opted_out;

CREATE INDEX IF NOT EXISTS idx_contacts_marketing_opted_out
  ON contacts (account_id) WHERE marketing_opted_out;

-- ============================================================
-- 2. CONEXIONES: límite 2026, salud, restricciones y warm-up
-- ============================================================
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_business_manager_messaging_limit TEXT,
  ADD COLUMN IF NOT EXISTS messaging_limit_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS restriction_scope TEXT,
  ADD COLUMN IF NOT EXISTS health_reason TEXT,
  ADD COLUMN IF NOT EXISTS restricted_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_health_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS warmup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_connections_health_status_check'
      AND conrelid = 'whatsapp_connections'::regclass
  ) THEN
    ALTER TABLE whatsapp_connections
      ADD CONSTRAINT whatsapp_connections_health_status_check
      CHECK (health_status IN ('healthy','warning','restricted','blocked'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_connections_restriction_scope_check'
      AND conrelid = 'whatsapp_connections'::regclass
  ) THEN
    ALTER TABLE whatsapp_connections
      ADD CONSTRAINT whatsapp_connections_restriction_scope_check
      CHECK (restriction_scope IS NULL OR restriction_scope IN ('mass','all'));
  END IF;
END $$;

UPDATE whatsapp_connections
SET display_phone_number =
      COALESCE(display_phone_number, phone_number),
    whatsapp_business_manager_messaging_limit =
      COALESCE(whatsapp_business_manager_messaging_limit, messaging_limit_tier),
    messaging_limit_updated_at =
      COALESCE(messaging_limit_updated_at, last_synced_at),
    warmup_started_at =
      CASE
        WHEN warmup_enabled AND warmup_started_at IS NULL THEN created_at
        ELSE warmup_started_at
      END;

COMMENT ON COLUMN whatsapp_connections.messaging_limit_tier IS
  'Deprecado. Usar whatsapp_business_manager_messaging_limit.';

CREATE OR REPLACE FUNCTION public.set_warmup_started_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.warmup_enabled AND NEW.warmup_started_at IS NULL THEN
    IF TG_OP = 'INSERT' OR OLD.warmup_enabled IS DISTINCT FROM TRUE THEN
      NEW.warmup_started_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_warmup_started_at ON whatsapp_connections;
CREATE TRIGGER set_warmup_started_at
  BEFORE INSERT OR UPDATE OF warmup_enabled ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_warmup_started_at();

-- ============================================================
-- 3. WARM-UP: contador diario y reserva atómica
-- ============================================================
CREATE TABLE IF NOT EXISTS connection_warmup_sends (
  connection_id UUID NOT NULL
    REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0
    CHECK (sent_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id, day)
);

ALTER TABLE connection_warmup_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connection_warmup_sends_select ON connection_warmup_sends;
CREATE POLICY connection_warmup_sends_select ON connection_warmup_sends FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM whatsapp_connections c
    WHERE c.id = connection_warmup_sends.connection_id
      AND is_account_member(c.account_id)
  ));

CREATE OR REPLACE FUNCTION public.reservar_envio_calentamiento(
  p_connection_id UUID,
  p_day DATE,
  p_limit INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN TRUE;
  END IF;

  INSERT INTO connection_warmup_sends (connection_id, day, sent_count)
  VALUES (p_connection_id, p_day, 1)
  ON CONFLICT (connection_id, day)
  DO UPDATE SET
    sent_count = connection_warmup_sends.sent_count + 1,
    updated_at = NOW()
  WHERE connection_warmup_sends.sent_count < p_limit
  RETURNING sent_count INTO v_count;

  RETURN v_count IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reservar_envio_calentamiento(UUID, DATE, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reservar_envio_calentamiento(UUID, DATE, INTEGER) TO service_role;

-- ============================================================
-- 4. BROADCASTS: conexión, pausa y error de entrega
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pause_reason TEXT;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN (
    'draft','scheduled','sending','paused','sent','failed'
  ));

CREATE INDEX IF NOT EXISTS idx_broadcasts_connection_status
  ON broadcasts (connection_id, status);

UPDATE broadcasts b
SET connection_id = c.id
FROM (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM whatsapp_connections
  ORDER BY account_id, created_at, id
) c
WHERE b.account_id = c.account_id
  AND b.connection_id IS NULL;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS error_code TEXT;

-- ============================================================
-- 5. LOG DE SALIDA: conexión, categoría y estados skipped
-- ============================================================
ALTER TABLE outbound_message_log
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_category TEXT;

ALTER TABLE outbound_message_log DROP CONSTRAINT IF EXISTS outbound_message_log_status_check;
ALTER TABLE outbound_message_log ADD CONSTRAINT outbound_message_log_status_check
  CHECK (status IN (
    'sending','sent','failed','blocked',
    'skipped_meta_limit','skipped_opt_out','skipped_warmup','skipped_quality'
  ));

CREATE INDEX IF NOT EXISTS idx_outbound_message_log_connection_time
  ON outbound_message_log (connection_id, created_at DESC);

UPDATE outbound_message_log l
SET connection_id = c.connection_id
FROM conversations c
WHERE l.conversation_id = c.id
  AND l.connection_id IS NULL;

-- ============================================================
-- 6. COLA: estados de omisión, pausa y código de error
-- ============================================================
ALTER TABLE outbound_message_queue
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS template_category TEXT;

ALTER TABLE outbound_message_queue DROP CONSTRAINT IF EXISTS outbound_message_queue_status_check;
ALTER TABLE outbound_message_queue ADD CONSTRAINT outbound_message_queue_status_check
  CHECK (status IN (
    'PENDING','PROCESSING','SENT','FAILED','CANCELLED','EXPIRED','PAUSED',
    'SKIPPED_META_LIMIT','SKIPPED_OPT_OUT','SKIPPED_WARMUP','SKIPPED_QUALITY'
  ));

-- ============================================================
-- 7. NOTIFICACIONES: salud de cuenta y plantillas
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned','sale_approved',
    'account_health','template_status','opt_out'
  ));

-- ============================================================
-- 8. PLANTILLAS: marca de botón de baja
-- ============================================================
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS has_opt_out_button BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE message_templates t
SET has_opt_out_button = EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(t.buttons, '[]'::jsonb)) AS b
  WHERE b->>'type' = 'QUICK_REPLY'
    AND (b->>'text') ~* '(dejar de recibir|darse de baja|baja|stop|unsubscribe)'
)
WHERE t.category = 'Marketing';
