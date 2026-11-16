-- ============================================================
-- 067_estado_conversacion.sql
--
-- FASE 3: estado de conversación por contacto, bloqueo (un solo
-- workflow a la vez), traspaso a humano y baja voluntaria.
--
-- Hasta hoy el CRM tenía banderas sueltas (ai_autoreply_disabled,
-- assigned_agent_id) y ninguna forma de decir «esta conversación la
-- lleva una persona», «esta clienta pidió que no le escribamos» o
-- «este contacto pidió hablar con alguien». Sin eso, cualquier módulo
-- podía escribirle y nadie sabía por qué.
--
-- Estados (uno por conversación, pegajosos los dos últimos):
--   NEW            recién creada, sin conversación todavía
--   ACTIVE         hay conversación en curso
--   WAITING_USER   el bot preguntó y espera respuesta de la clienta
--   WAITING_AI     la clienta escribió y falta responder
--   HUMAN_HANDOFF  la lleva una persona; la automatización se aparta
--   PAUSED         en pausa a mano
--   OPT_OUT        pidió que no le escribamos
--   CLOSED         cerrada
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ,
  -- Bloqueo por conversación: evita que dos procesos contesten a la vez.
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_state_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_state_check
  CHECK (state IN (
    'NEW', 'ACTIVE', 'WAITING_USER', 'WAITING_AI',
    'HUMAN_HANDOFF', 'PAUSED', 'OPT_OUT', 'CLOSED'
  ));

COMMENT ON COLUMN conversations.state IS
  'Estado de la conversación (fase 3 de la capa de mensajería).';
COMMENT ON COLUMN conversations.locked_until IS
  'Hasta cuándo está tomada la conversación por un proceso.';

-- Para el barrido futuro del estado y de los bloqueos vencidos.
CREATE INDEX IF NOT EXISTS conversations_state_idx
  ON conversations (account_id, state);
CREATE INDEX IF NOT EXISTS conversations_locked_until_idx
  ON conversations (locked_until)
  WHERE locked_until IS NOT NULL;

-- ---------- baja voluntaria (opt-out) ----------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opt_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_out_reason TEXT;

COMMENT ON COLUMN contacts.opt_out_at IS
  'Cuándo pidió la clienta que no se le escriba más. Bloquea el '
  'marketing automático de forma permanente hasta que ella vuelva a '
  'escribir.';

-- ---------- consentimiento (origen del contacto) ----------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS consent_status TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS consent_source TEXT,
  ADD COLUMN IF NOT EXISTS consent_type TEXT,
  ADD COLUMN IF NOT EXISTS consent_timestamp TIMESTAMPTZ;

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_consent_status_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_consent_status_check
  CHECK (consent_status IN ('unknown', 'granted', 'denied', 'pending'));

COMMENT ON COLUMN contacts.consent_status IS
  'Consentimiento del contacto: granted | denied | pending | unknown. '
  'Tener el número no autoriza a mandar comunicaciones posteriores.';
COMMENT ON COLUMN contacts.consent_source IS
  'De dónde llegó: META_AD | WEBSITE | ORGANIC | REFERRAL | MANUAL | OTHER.';
COMMENT ON COLUMN contacts.consent_type IS
  'Tipo de consentimiento: marketing | transactional | unknown.';
