-- ============================================================
-- 085_replace_flow_graph_admin.sql
--
-- El servidor MCP escribe flujos sin una sesión de Supabase, así que
-- `replace_flow_graph` (058) no sirve: su `replace_flow_nodes` exige
-- `auth.uid()`. Esta variante recibe el account_id, verifica que el
-- flujo pertenezca a la cuenta y solo se concede a service_role.
--
-- Misma semántica que el guardado del editor: reemplaza el grafo,
-- cancela las corridas cuyo nodo actual desapareció y actualiza los
-- metadatos del flujo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.replace_flow_graph_admin(
  p_flow_id UUID,
  p_account_id UUID,
  p_nodes JSONB,
  p_flow JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cancelled INTEGER;
  v_found BOOLEAN;
BEGIN
  IF p_flow IS NULL OR jsonb_typeof(p_flow) <> 'object' THEN
    RAISE EXCEPTION 'p_flow must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT TRUE INTO v_found
  FROM flows
  WHERE id = p_flow_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = '42501';
  END IF;

  DELETE FROM flow_nodes WHERE flow_id = p_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    p_flow_id,
    n->>'node_key',
    n->>'node_type',
    COALESCE(n->'config', '{}'::jsonb),
    COALESCE((n->>'position_x')::INTEGER, 0),
    COALESCE((n->>'position_y')::INTEGER, 0)
  FROM jsonb_array_elements(p_nodes) AS n;

  UPDATE flow_runs r
  SET status = 'cancelled',
      ended_at = NOW(),
      end_reason = 'current_node_removed'
  WHERE r.flow_id = p_flow_id
    AND r.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM flow_nodes fn
      WHERE fn.flow_id = p_flow_id
        AND fn.node_key = r.current_node_key
    );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE flows
  SET name = CASE WHEN p_flow ? 'name' THEN p_flow->>'name' ELSE name END,
      description = CASE WHEN p_flow ? 'description' THEN p_flow->>'description' ELSE description END,
      trigger_type = CASE WHEN p_flow ? 'trigger_type' THEN p_flow->>'trigger_type' ELSE trigger_type END,
      trigger_config = CASE WHEN p_flow ? 'trigger_config' THEN p_flow->'trigger_config' ELSE trigger_config END,
      entry_node_id = CASE WHEN p_flow ? 'entry_node_id' THEN p_flow->>'entry_node_id' ELSE entry_node_id END,
      fallback_policy = CASE WHEN p_flow ? 'fallback_policy' THEN p_flow->'fallback_policy' ELSE fallback_policy END,
      updated_at = NOW()
  WHERE id = p_flow_id;

  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_flow_graph_admin(UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_flow_graph_admin(UUID, UUID, JSONB, JSONB)
  TO service_role;
