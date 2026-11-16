-- ============================================================
-- 068_cola_salida.sql
--
-- FASE 4: cola de salida. Hasta ahora un envío fallido se perdía (o
-- quien llamó tenía que reintentar a mano, con riesgo de duplicar).
-- Con la cola:
--   - los reintentos son idempotentes (una fila por mensaje, con clave);
--   - un fallo temporal (5xx, 429, red) se reprograma con espera
--     creciente en vez de perderse;
--   - un mensaje que ya no tiene sentido (la clienta contestó, pidió
--     humano o se dio de baja) se puede CANCELAR antes de que salga;
--   - un solo worker (el cron) la vacía, así que no hay carreras.
-- ============================================================

CREATE TABLE IF NOT EXISTS outbound_message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Qué mandar y con qué argumentos (para poder reintentar sin volver a
  -- resolver todo desde cero).
  message_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_preview TEXT,

  -- Por qué y desde dónde (misma auditoría que outbound_message_log).
  reason TEXT,
  source TEXT NOT NULL,
  workflow_id UUID,
  workflow_node_key TEXT,
  source_event_id TEXT,
  idempotency_key TEXT,

  -- Control
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED','EXPIRED')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  whatsapp_message_id TEXT,
  cancel_reason TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una misma intención de envío no se encola dos veces (§19).
CREATE UNIQUE INDEX IF NOT EXISTS outbound_message_queue_idempotency_idx
  ON outbound_message_queue (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_message_queue_due_idx
  ON outbound_message_queue (status, next_retry_at, scheduled_at, created_at);
CREATE INDEX IF NOT EXISTS outbound_message_queue_conversation_idx
  ON outbound_message_queue (conversation_id, status);

COMMENT ON TABLE outbound_message_queue IS
  'Cola de salida de la capa segura de mensajería (fase 4). La vacía '
  'POST /api/messaging/cron.';

ALTER TABLE outbound_message_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_message_queue_select ON outbound_message_queue;
CREATE POLICY outbound_message_queue_select ON outbound_message_queue
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS outbound_message_queue_insert ON outbound_message_queue;
CREATE POLICY outbound_message_queue_insert ON outbound_message_queue
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

-- Toma un lote para procesar SIN que dos workers se pisen: la selección
-- lleva FOR UPDATE SKIP LOCKED, así que la fila que ya tomó uno no la ve
-- el otro.
CREATE OR REPLACE FUNCTION public.claim_outbound_queue(p_limit INT)
RETURNS SETOF outbound_message_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE outbound_message_queue q
  SET status = 'PROCESSING',
      attempt_number = q.attempt_number + 1,
      locked_at = NOW(),
      updated_at = NOW()
  WHERE q.id IN (
    SELECT id FROM outbound_message_queue
    WHERE status = 'PENDING'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    ORDER BY priority DESC, created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.*;
$$;

ALTER FUNCTION public.claim_outbound_queue(INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_outbound_queue(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_outbound_queue(INT) TO authenticated;
