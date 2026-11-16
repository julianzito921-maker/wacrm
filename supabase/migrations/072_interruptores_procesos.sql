-- ============================================================
-- 072_interruptores_procesos.sql
--
-- Dos procesos que escriben a la clienta por su cuenta y que hay que
-- poder apagar sin tocar el programador que los llama ni desplegar:
--
--   - `barrido_pendientes_activo`: cada 2 h hace que el agente conteste
--     conversaciones que se quedaron calladas. Es proactivo: sube los
--     bloqueos aunque respete la ventana de 24 h.
--   - `recordatorios_pago_activos`: manda recordatorios de pago a la
--     hora que dijo la clienta. Fue el origen de los mensajes fuera de
--     la ventana (29 h sin respuesta).
--
-- Los dos nacen APAGADOS: se encienden cuando el número esté estable.
-- ============================================================

INSERT INTO messaging_flags (key, valor, reason)
VALUES
  ('barrido_pendientes_activo', false, 'apagado al estrenar la capa de mensajería'),
  ('recordatorios_pago_activos', false, 'apagado al estrenar la capa de mensajería')
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN messaging_flags.valor IS
  'true = el proceso puede escribir; false = se salta sin enviar nada.';
