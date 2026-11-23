-- ============================================================
-- 080_flow_any_message_trigger.sql
--
-- Flow Builder: disparador «Cualquier mensaje» (bloque Inicio).
--   1. flows.trigger_type admite 'any_message'. Va al final de la
--      prioridad (palabra clave → primer mensaje → cualquier mensaje) y
--      se dispara una vez por contacto cada 24 h (lo controla el motor).
--   2. Índice para esa comprobación de 24 h: corridas de un flujo para
--      un contacto, de la más reciente a la más vieja.
--
-- El Mensaje compuesto (burbujas) y el fin de rama no necesitan cambios
-- de esquema: viven en flow_nodes.config y flow_runs.vars.
--
-- Solo agrega. Idempotente.
-- ============================================================

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check;
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'any_message', 'manual'));

CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_contact_started
  ON flow_runs (flow_id, contact_id, started_at DESC);
