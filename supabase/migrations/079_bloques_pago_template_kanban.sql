-- ============================================================
-- 079_bloques_pago_template_kanban.sql
--
-- Flow Builder: tres bloques que pasan de «Próximamente» a funcionales.
--   - send_payment  (Botón Pago / SPEI): manda los datos SPEI y espera el
--                    comprobante; lo lee la IA y sale por Aprobado o
--                    Rechazado / Timeout.
--   - send_template (Template WhatsApp): plantilla aprobada por Meta con
--                    variables tomadas del contacto o del flujo.
--   - move_kanban   (Kanban): mueve el trato del contacto a una etapa.
--
-- 1. CHECK de flow_nodes con los tres tipos nuevos.
-- 2. resume_reason 'payment_timeout' (espera del comprobante).
-- 3. payment_receipts: cada comprobante leído (auditoría) y antifraude
--    real: la misma referencia no se aprueba dos veces en la cuenta.
-- 4. redeem_invitation (copia de la 078) revisa también payment_receipts.
--
-- Idempotente.
-- ============================================================

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'wait',
    'save_reply',
    'condition',
    'set_tag',
    'handoff',
    'meta_capi',
    'end',
    'send_payment',
    'send_template',
    'move_kanban'
  ));

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_resume_reason_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_resume_reason_check
  CHECK (resume_reason IS NULL OR resume_reason IN ('delay', 'reply_timeout', 'payment_timeout'));

CREATE TABLE IF NOT EXISTS payment_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  flow_run_id UUID REFERENCES flow_runs(id) ON DELETE SET NULL,
  node_key TEXT,
  whatsapp_media_id TEXT,
  monto NUMERIC(12,2),
  ultimos_digitos TEXT,
  banco_destino TEXT,
  referencia TEXT,
  estado TEXT,
  resultado TEXT NOT NULL CHECK (resultado IN ('aprobado', 'rechazado', 'revisar')),
  motivos TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La misma referencia no se puede aprobar dos veces en la cuenta.
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_ref_aprobada
  ON payment_receipts(account_id, referencia)
  WHERE referencia IS NOT NULL AND resultado = 'aprobado';
CREATE INDEX IF NOT EXISTS idx_payment_receipts_contact
  ON payment_receipts(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_account
  ON payment_receipts(account_id);

ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_receipts_select ON payment_receipts;
CREATE POLICY payment_receipts_select ON payment_receipts
  FOR SELECT USING (is_account_member(account_id));
-- Escritura solo desde el servidor (service role): sin política de escritura.

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
    -- 062: catálogo de productos y lo entendido de imágenes y notas de voz.
    UNION ALL SELECT 1 FROM product_catalog WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM media_understanding WHERE account_id = v_old_account_id
    -- 064: registro de cada envio saliente (evidencia de auditoria).
    UNION ALL SELECT 1 FROM outbound_message_log WHERE account_id = v_old_account_id
    -- 068: cola de salida pendiente de enviar.
    UNION ALL SELECT 1 FROM outbound_message_queue WHERE account_id = v_old_account_id
    -- 070: alertas de riesgo de la capa de mensajeria.
    UNION ALL SELECT 1 FROM messaging_alerts WHERE account_id = v_old_account_id
    -- 074: datos de pago configurados en el servidor.
    UNION ALL SELECT 1 FROM payment_details WHERE account_id = v_old_account_id
    -- 076: notas internas del equipo en las conversaciones.
    UNION ALL SELECT 1 FROM conversation_notes WHERE account_id = v_old_account_id
    -- 079: comprobantes de pago leídos por el flujo.
    UNION ALL SELECT 1 FROM payment_receipts WHERE account_id = v_old_account_id
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
