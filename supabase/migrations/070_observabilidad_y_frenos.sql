-- ============================================================
-- 070_observabilidad_y_frenos.sql
--
-- FASE 6: ver el riesgo y poder frenar.
--
--   1. `messaging_flags` — el interruptor de emergencia deja de ser sólo
--      una variable de entorno: se puede apagar desde la base y sigue
--      apagado aunque el proceso se reinicie.
--   2. `messaging_alerts` — cada anomalía detectada queda registrada con
--      su regla, su valor y lo que se hizo (por ejemplo, pausar un flujo).
--   3. `flows.auto_paused_at` / `auto_pause_reason` — un flujo que se
--      desboca se pausa solo, y se ve por qué.
-- ============================================================

CREATE TABLE IF NOT EXISTS messaging_flags (
  key TEXT PRIMARY KEY,
  valor BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE messaging_flags IS
  'Interruptores de la capa de mensajería. `automatizacion_activa=false` '
  'detiene todos los envíos automáticos sin desconectar la cuenta.';

INSERT INTO messaging_flags (key, valor, reason)
VALUES ('automatizacion_activa', true, 'valor inicial')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE messaging_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messaging_flags_select ON messaging_flags;
CREATE POLICY messaging_flags_select ON messaging_flags FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS messaging_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  regla TEXT NOT NULL,
  severidad TEXT NOT NULL DEFAULT 'warning'
    CHECK (severidad IN ('info', 'warning', 'critical')),
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb,
  accion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messaging_alerts_time_idx
  ON messaging_alerts (created_at DESC);

COMMENT ON TABLE messaging_alerts IS
  'Anomalías detectadas por la capa de mensajería (fase 6) con la '
  'acción que se tomó: avisar, pausar el flujo o apagar la automatización.';

ALTER TABLE messaging_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messaging_alerts_select ON messaging_alerts;
CREATE POLICY messaging_alerts_select ON messaging_alerts
  FOR SELECT USING (is_account_member(account_id));

-- Pausa automática por flujo.
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS auto_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_pause_reason TEXT;

COMMENT ON COLUMN flows.auto_pause_reason IS
  'Por qué se pausó solo este flujo (fase 6): ráfaga, duplicados, '
  'relación outbound/usuario alta…';
