-- ============================================================
-- 084_mcp_credentials.sql
--
-- Credenciales del servidor MCP remoto (/api/mcp). El token completo
-- se muestra una sola vez; aquí solo vive su SHA-256 y un prefijo
-- visible para distinguir credenciales en el panel.
--
-- Nota: la 082 y la 083 pertenecen a Seguimiento; esta es la 084.
-- Solo agrega.
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- "mcp_live_" + 8 caracteres. No es secreto.
  key_prefix TEXT NOT NULL,
  -- SHA-256 hex del token completo. Nunca se guarda el texto plano.
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_credentials_scopes_check CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['read', 'write_flows', 'write_crm', 'send_messages']::TEXT[]
  )
);

CREATE INDEX IF NOT EXISTS idx_mcp_credentials_account
  ON mcp_credentials(account_id);
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_active
  ON mcp_credentials(account_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON mcp_credentials;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON mcp_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE mcp_credentials ENABLE ROW LEVEL SECURITY;

-- Solo administradores gestionan credenciales desde la app. El servidor
-- MCP las resuelve con service_role y siempre filtra por account_id.
DROP POLICY IF EXISTS mcp_credentials_admin ON mcp_credentials;
CREATE POLICY mcp_credentials_admin ON mcp_credentials FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

COMMENT ON TABLE mcp_credentials IS
  'Tokens de conectores MCP. Solo se guarda el SHA-256; el texto plano se muestra una vez al crearlo.';
