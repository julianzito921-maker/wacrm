-- 093_flow_final_blocks.sql
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start','send_buttons','send_list','send_message','send_media',
    'collect_input','wait','save_reply','condition','set_tag','handoff',
    'meta_capi','end','send_payment','send_template','move_kanban',
    'connect_flow','ai_block','manipulator','distributor',
    'notification','sale_approved','carousel'
  ));

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_resume_reason_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_resume_reason_check
  CHECK (resume_reason IS NULL OR resume_reason IN (
    'delay','reply_timeout','payment_timeout',
    'reply_buffer','awaiting_reply','carousel_timeout'
  ));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned','sale_approved'));

CREATE TABLE IF NOT EXISTS flow_distributor_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, node_key, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_distributor_assignments_account
  ON flow_distributor_assignments(account_id, flow_id, node_key);
ALTER TABLE flow_distributor_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_distributor_assignments_select ON flow_distributor_assignments;
CREATE POLICY flow_distributor_assignments_select ON flow_distributor_assignments FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS flow_distributor_state (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, node_key)
);
ALTER TABLE flow_distributor_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_distributor_state_select ON flow_distributor_state;
CREATE POLICY flow_distributor_state_select ON flow_distributor_state FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION public.elegir_salida_distribuidor(
  p_account_id UUID, p_flow_id UUID, p_node_key TEXT, p_contact_id UUID,
  p_outputs INTEGER, p_avoid_repeat BOOLEAN
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existente INTEGER; v_elegida INTEGER;
BEGIN
  IF p_outputs < 1 THEN
    RAISE EXCEPTION 'outputs must be >= 1' USING ERRCODE = '22023';
  END IF;
  IF p_avoid_repeat THEN
    SELECT output_index INTO v_existente FROM flow_distributor_assignments
    WHERE flow_id = p_flow_id AND node_key = p_node_key AND contact_id = p_contact_id;
    IF FOUND THEN RETURN v_existente; END IF;
  END IF;
  INSERT INTO flow_distributor_state (account_id, flow_id, node_key, next_index)
  VALUES (p_account_id, p_flow_id, p_node_key, 1)
  ON CONFLICT (flow_id, node_key)
  DO UPDATE SET next_index = flow_distributor_state.next_index + 1, updated_at = NOW()
  RETURNING (next_index - 1) % p_outputs INTO v_elegida;
  INSERT INTO flow_distributor_assignments
    (account_id, flow_id, node_key, contact_id, output_index)
  VALUES (p_account_id, p_flow_id, p_node_key, p_contact_id, v_elegida)
  ON CONFLICT (flow_id, node_key, contact_id)
  DO UPDATE SET output_index = flow_distributor_assignments.output_index
  RETURNING output_index INTO v_elegida;
  RETURN v_elegida;
END; $$;
REVOKE ALL ON FUNCTION public.elegir_salida_distribuidor(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elegir_salida_distribuidor(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN)
  TO service_role;
