-- ============================================================
-- 099_dapi_conexiones.sql
--
-- Configuración → Integraciones, igual que en Leona:
--   1. `account_integrations`: una clave secreta (cifrada) por cuenta y
--      proveedor: 'dapi' (WhatsApp Web por QR), 'openrouter' (IA) y
--      'lowtrack' (seguimiento de ventas) y 'leona' (credencial MCP de
--      Leona para importar sus flujos).
--   2. `whatsapp_connections.provider`: 'meta' (Cloud API) o 'dapi'.
--      Una isla D-API guarda `phone_number_id = 'dapi:<sessionId>'`,
--      `access_token` = API Key cifrada y `verify_token` = secreto del
--      webhook de entrada (cifrado). Así el resto del CRM la trata como
--      cualquier otra isla.
--
-- Requiere 089 y 098. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS account_integrations (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('dapi', 'openrouter', 'lowtrack', 'leona')),
  name TEXT,
  secret TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, provider)
);

DROP TRIGGER IF EXISTS set_updated_at ON account_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE account_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_integrations_admin ON account_integrations;
CREATE POLICY account_integrations_admin ON account_integrations FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Variables globales de la cuenta (Configuración → Variables globales).
-- Los flujos las leen como {{vars.<key>}}.
CREATE TABLE IF NOT EXISTS account_variables (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key ~ '^[a-zA-Z0-9_]{1,60}$'),
  value TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, key)
);

ALTER TABLE account_variables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_variables_select ON account_variables;
CREATE POLICY account_variables_select ON account_variables FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS account_variables_write ON account_variables;
CREATE POLICY account_variables_write ON account_variables FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_connections_provider_check'
      AND conrelid = 'whatsapp_connections'::regclass
  ) THEN
    ALTER TABLE whatsapp_connections
      ADD CONSTRAINT whatsapp_connections_provider_check
      CHECK (provider IN ('meta', 'dapi'));
  END IF;
END $$;

GRANT SELECT (provider) ON whatsapp_connections TO authenticated;

-- ============================================================
-- 099: el redeem debe conocer account_integrations.
-- Copia de la función de la 098 con una línea más.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM product_catalog WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM media_understanding WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM outbound_message_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM outbound_message_queue WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM messaging_alerts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_details WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversation_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_receipts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_pixels WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_links WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_clicks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_attribution WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM mcp_credentials WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM sales WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ad_spend WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_connections WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_distributor_assignments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_distributor_state WHERE account_id = v_old_account_id
    -- 095: bloques finales del Flow Builder.
    UNION ALL SELECT 1 FROM departments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_payment_sessions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_gateway_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_webhook_events WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_call_sessions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_calling_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_media_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_credentials WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM account_integrations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM account_variables WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_attribution_islas WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
