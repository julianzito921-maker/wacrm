-- ============================================================
-- 095_bloques_finales.sql
--
-- Flow Builder: cierre del catálogo con los bloques de las capturas
-- finales.
--   1. `wait` programado (fecha y horario hábil) — solo config.
--   2. `department` — departamentos de la cuenta y conversación.
--   3. `http_request` — credenciales cifradas para integraciones.
--   4. `payment_gateway` — sesiones, credenciales y webhooks.
--   5. `ai_media` — configuración de audio/imagen.
--   6. `official_call` — permiso de llamada y estado de calling.
--
-- Requiere 093/094 aplicadas. Idempotente.
-- ============================================================

-- ============================================================
-- 1. Tipos de nodo
-- ============================================================
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start','send_buttons','send_list','send_message','send_media',
    'collect_input','wait','save_reply','condition','set_tag','handoff',
    'meta_capi','end','send_payment','send_template','move_kanban',
    'connect_flow','ai_block','manipulator','distributor','notification',
    'sale_approved','carousel',
    'department','http_request','payment_gateway','ai_media','official_call'
  ));

-- ============================================================
-- 2. Motivos de reanudación
-- ============================================================
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_resume_reason_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_resume_reason_check
  CHECK (resume_reason IS NULL OR resume_reason IN (
    'delay','reply_timeout','payment_timeout','reply_buffer',
    'awaiting_reply','carousel_timeout','payment_gateway','call_permission'
  ));

-- ============================================================
-- 3. Zona horaria y horario hábil de la cuenta
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Mexico_City';
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT
    '{"enabled":false,"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'::jsonb;

-- ============================================================
-- 4. Departamentos
-- ============================================================
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  color TEXT NOT NULL DEFAULT '#6366f1'
    CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS departments_account_name_key
  ON departments (account_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_departments_account
  ON departments (account_id, is_active, sort_order);

DROP TRIGGER IF EXISTS set_updated_at ON departments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS departments_select ON departments;
CREATE POLICY departments_select ON departments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS departments_write ON departments;
CREATE POLICY departments_write ON departments FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Semilla inicial pedida por Julián: Ventas, Soporte y Cobranza.
INSERT INTO departments (account_id, name, color, sort_order)
SELECT a.id, d.name, d.color, d.sort_order
FROM accounts a
CROSS JOIN (VALUES
  ('Ventas',   '#6C47FF', 0),
  ('Soporte',  '#0EA5E9', 1),
  ('Cobranza', '#F59E0B', 2)
) AS d(name, color, sort_order)
ON CONFLICT (account_id, (lower(btrim(name)))) DO NOTHING;

-- Cuentas nuevas: siembra los tres departamentos por defecto.
CREATE OR REPLACE FUNCTION public.seed_default_departments()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO departments (account_id, name, color, sort_order)
  VALUES
    (NEW.id, 'Ventas',   '#6C47FF', 0),
    (NEW.id, 'Soporte',  '#0EA5E9', 1),
    (NEW.id, 'Cobranza', '#F59E0B', 2)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_default_departments ON accounts;
CREATE TRIGGER seed_default_departments
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_departments();

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS department_id UUID
  REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_department
  ON conversations (account_id, department_id);

-- ============================================================
-- 5. Sesiones de pago
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_payment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN (
    'hotmart','whop','mercadopago','stripe','spei'
  )),
  reference TEXT NOT NULL,
  external_id TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('MXN','USD')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','rejected','expired','cancelled'
  )),
  checkout_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
  capi_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  UNIQUE (account_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_flow_payment_sessions_run
  ON flow_payment_sessions (flow_run_id);
CREATE INDEX IF NOT EXISTS idx_flow_payment_sessions_pending
  ON flow_payment_sessions (account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_flow_payment_sessions_external
  ON flow_payment_sessions (provider, external_id)
  WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON flow_payment_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON flow_payment_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE flow_payment_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_payment_sessions_select ON flow_payment_sessions;
CREATE POLICY flow_payment_sessions_select ON flow_payment_sessions FOR SELECT
  USING (is_account_member(account_id));
-- Escritura solo service_role.

-- ============================================================
-- 6. Credenciales de pasarelas (cifradas)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_gateway_configs (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN (
    'hotmart','whop','mercadopago','stripe','spei'
  )),
  webhook_secret TEXT,
  api_key TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, provider)
);

DROP TRIGGER IF EXISTS set_updated_at ON payment_gateway_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_gateway_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE payment_gateway_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_gateway_configs_admin ON payment_gateway_configs;
CREATE POLICY payment_gateway_configs_admin ON payment_gateway_configs FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- 7. Idempotencia de webhooks de pago
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN (
    'hotmart','whop','mercadopago','stripe','spei'
  )),
  event_id TEXT NOT NULL,
  reference TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_reference
  ON payment_webhook_events (reference)
  WHERE reference IS NOT NULL;

ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_webhook_events_select ON payment_webhook_events;
CREATE POLICY payment_webhook_events_select ON payment_webhook_events FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));
-- Escritura solo service_role.

-- ============================================================
-- 8. Ventas originadas por pasarela
-- ============================================================
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_source_check;
ALTER TABLE sales ADD CONSTRAINT sales_source_check
  CHECK (source IN (
    'manual','deal','payment_receipt','import','payment_gateway'
  ));

-- ============================================================
-- 9. Sesiones de llamada oficial
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  connection_id UUID REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  phone_number_id TEXT NOT NULL,
  request_wamid TEXT,
  call_id TEXT,
  permission_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    permission_status IN ('unknown','no_permission','temporary','permanent')
  ),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','granted','denied','expired','calling','completed','failed'
  )),
  is_permanent BOOLEAN,
  expires_at TIMESTAMPTZ,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_run_id, node_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS flow_call_sessions_call_id_key
  ON flow_call_sessions (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_call_sessions_account
  ON flow_call_sessions (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_call_sessions_wamid
  ON flow_call_sessions (request_wamid) WHERE request_wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_call_sessions_contact
  ON flow_call_sessions (contact_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON flow_call_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON flow_call_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE flow_call_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_call_sessions_select ON flow_call_sessions;
CREATE POLICY flow_call_sessions_select ON flow_call_sessions FOR SELECT
  USING (is_account_member(account_id));
-- Escritura solo service_role.

-- ============================================================
-- 10. Configuración de llamadas por conexión
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_calling_configs (
  connection_id UUID PRIMARY KEY
    REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  calling_status JSONB,
  checked_at TIMESTAMPTZ,
  bridge_url TEXT,
  bridge_secret TEXT,
  bridge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calling_configs_account
  ON whatsapp_calling_configs (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_calling_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_calling_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whatsapp_calling_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_calling_configs_select ON whatsapp_calling_configs;
CREATE POLICY whatsapp_calling_configs_select ON whatsapp_calling_configs FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS whatsapp_calling_configs_write ON whatsapp_calling_configs;
CREATE POLICY whatsapp_calling_configs_write ON whatsapp_calling_configs FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- 11. Configuración de IA multimedia
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_media_configs (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  image_provider TEXT NOT NULL DEFAULT 'pollinations' CHECK (
    image_provider IN ('pollinations','together','flux','openai')
  ),
  image_api_key TEXT,
  image_model TEXT,
  audio_provider TEXT NOT NULL DEFAULT 'edge' CHECK (
    audio_provider IN ('edge','openai')
  ),
  audio_api_key TEXT,
  audio_model TEXT,
  default_voice TEXT NOT NULL DEFAULT 'es-MX-DaliaNeural',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_updated_at ON ai_media_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_media_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_media_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_media_configs_admin ON ai_media_configs;
CREATE POLICY ai_media_configs_admin ON ai_media_configs FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- 12. Credenciales cifradas para Integración HTTP
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  value TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS flow_credentials_account_name_key
  ON flow_credentials (account_id, lower(btrim(name)));

DROP TRIGGER IF EXISTS set_updated_at ON flow_credentials;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON flow_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE flow_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_credentials_select ON flow_credentials;
CREATE POLICY flow_credentials_select ON flow_credentials FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS flow_credentials_write ON flow_credentials;
CREATE POLICY flow_credentials_write ON flow_credentials FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
