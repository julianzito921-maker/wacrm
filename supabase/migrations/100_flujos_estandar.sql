-- ============================================================
-- 100_flujos_estandar.sql
--
-- Flujos estándar por conexión de WhatsApp (como Leona):
-- bienvenida, conversación finalizada, respuesta predeterminada
-- (con horas de espera), atención finalizada y palabras clave.
-- Se leen y escriben solo desde el servidor (service role).
-- Idempotente.
-- ============================================================

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS standard_flows JSONB NOT NULL DEFAULT '{}'::jsonb;
