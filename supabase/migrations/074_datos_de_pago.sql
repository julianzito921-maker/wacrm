-- ============================================================
-- 074_datos_de_pago.sql
--
-- Los datos bancarios son CONFIGURACIÓN DEL SERVIDOR, nunca algo que el
-- modelo pueda escribir, inventar o cambiar (regla §7 y §12 del proyecto
-- Melissa Autónoma).
--
-- Vive en su propia tabla y no en el prompt por tres razones:
--   1. el modelo no los ve como texto libre que pueda alterar;
--   2. se pueden revisar y cambiar sin tocar el prompt;
--   3. quedan fuera del repositorio (la tabla nace vacía y se llena por
--      script: ningún dato bancario entra en git).
--
-- La columna `mensaje` es lo que se envía tal cual a la clienta, una sola
-- vez y solo después de entregar el material.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_details (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  /** Titular de la cuenta (auditoría; lo muestra el panel). */
  holder TEXT,
  bank TEXT,
  clabe TEXT,
  oxxo TEXT,
  /** Mensaje exacto que recibe la clienta. */
  mensaje TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE payment_details IS
  'Datos de pago de la cuenta. Configuración del servidor: el agente solo '
  'puede enviarlos, nunca modificarlos.';

ALTER TABLE payment_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_details_select ON payment_details;
CREATE POLICY payment_details_select ON payment_details
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS payment_details_write ON payment_details;
CREATE POLICY payment_details_write ON payment_details
  FOR ALL USING (is_account_member(account_id, 'admin'));
