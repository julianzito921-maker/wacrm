-- ============================================================
-- 066_safety_layer.sql
--
-- FASE 2: la capa de seguridad ya no sólo registra, también decide.
-- Cuando un envío se bloquea hay que poder verlo y por qué, así que el
-- registro gana:
--
--   - `blocked` como estado válido (un envío bloqueado no llegó a Meta,
--     pero queda la huella de que se intentó y la regla que lo frenó);
--   - `blocked_reason` con la regla exacta (ventana de 24 h, límite por
--     minuto/hora/día, demasiados mensajes seguidos, duplicado,
--     automatización apagada).
--
-- Sirve para lo que pedía Julián: poder auditar por qué NO se mandó algo
-- igual que por qué sí.
-- ============================================================

-- El CHECK del estado se rehace para incluir 'blocked'.
ALTER TABLE outbound_message_log
  DROP CONSTRAINT IF EXISTS outbound_message_log_status_check;

ALTER TABLE outbound_message_log
  ADD CONSTRAINT outbound_message_log_status_check
  CHECK (status IN ('sending', 'sent', 'failed', 'blocked'));

ALTER TABLE outbound_message_log
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

COMMENT ON COLUMN outbound_message_log.blocked_reason IS
  'Regla que impidió el envío: window_24h, limit_per_minute, '
  'limit_per_hour, limit_per_day, too_many_consecutive, duplicate, '
  'automation_disabled.';

-- Para que la política cuente rápido los envíos recientes de un contacto.
CREATE INDEX IF NOT EXISTS outbound_message_log_contact_time_idx
  ON outbound_message_log (contact_id, created_at DESC);
