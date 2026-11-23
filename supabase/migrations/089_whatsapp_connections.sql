-- 089_whatsapp_connections.sql
-- Multi-conexión de WhatsApp Cloud API. La tabla vieja whatsapp_config
-- se conserva una release como respaldo (decisión aprobada).

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone_number TEXT,
  phone_number_id TEXT NOT NULL UNIQUE,
  waba_id TEXT,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  app_secret TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'disconnected')),
  quality_rating TEXT,
  messaging_limit_tier TEXT,
  badge_color TEXT NOT NULL DEFAULT '#6366f1'
    CHECK (badge_color ~ '^#[0-9a-fA-F]{6}$'),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account
  ON whatsapp_connections(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_connections_select ON whatsapp_connections;
CREATE POLICY whatsapp_connections_select ON whatsapp_connections FOR SELECT
  USING (is_account_member(account_id));

REVOKE ALL ON TABLE whatsapp_connections FROM anon, authenticated;
GRANT SELECT (
  id, account_id, name, phone_number, phone_number_id, waba_id, status,
  quality_rating, messaging_limit_tier, badge_color, last_synced_at,
  created_at, updated_at
) ON whatsapp_connections TO authenticated;
GRANT ALL ON TABLE whatsapp_connections TO service_role;

INSERT INTO whatsapp_connections (
  account_id, name, phone_number, phone_number_id, waba_id,
  access_token, verify_token, app_secret, status, badge_color,
  created_at, updated_at
)
SELECT
  wc.account_id,
  'WhatsApp ' || right(wc.phone_number_id, 4),
  NULL,
  wc.phone_number_id,
  wc.waba_id,
  wc.access_token,
  wc.verify_token,
  NULL,
  wc.status,
  '#6366f1',
  wc.created_at,
  wc.updated_at
FROM whatsapp_config wc
WHERE wc.account_id IS NOT NULL
ON CONFLICT (phone_number_id) DO NOTHING;

-- Conversaciones por contacto + conexión.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

UPDATE conversations c
SET connection_id = w.id
FROM (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM whatsapp_connections
  ORDER BY account_id, created_at, id
) w
WHERE c.account_id = w.account_id AND c.connection_id IS NULL;

DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_connection
  ON conversations(account_id, contact_id, connection_id)
  WHERE connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_connection
  ON conversations(account_id, connection_id, last_message_at DESC);

-- Flujos: NULL = todas las conexiones.
ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

-- Cola: con qué conexión se envió.
ALTER TABLE outbound_message_queue
  ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES whatsapp_connections(id) ON DELETE SET NULL;
UPDATE outbound_message_queue q
SET connection_id = c.connection_id
FROM conversations c
WHERE q.conversation_id = c.id AND q.connection_id IS NULL;

-- Enlaces de atribución.
ALTER TABLE tracking_links
  ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES whatsapp_connections(id) ON DELETE SET NULL;
UPDATE tracking_links l
SET connection_id = w.id
FROM (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM whatsapp_connections
  ORDER BY account_id, created_at, id
) w
WHERE l.account_id = w.account_id AND l.connection_id IS NULL;

-- Plantillas por WABA.
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS waba_id TEXT;
UPDATE message_templates t
SET waba_id = w.waba_id
FROM (
  SELECT DISTINCT ON (account_id) account_id, waba_id
  FROM whatsapp_connections
  WHERE waba_id IS NOT NULL
  ORDER BY account_id, created_at, id
) w
WHERE t.account_id = w.account_id AND t.waba_id IS NULL;

DROP INDEX IF EXISTS message_templates_account_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON message_templates(account_id, COALESCE(waba_id, ''), name, language);
