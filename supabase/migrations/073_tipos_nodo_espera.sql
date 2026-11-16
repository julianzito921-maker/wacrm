-- ============================================================
-- 073_tipos_nodo_espera.sql
--
-- BUG: la fase 3 añadió los nodos `wait` (temporizador) y
-- `save_reply` (guardar respuesta) al código, pero la restricción de la
-- tabla se quedó como estaba en la migración 016. Resultado: **esos
-- nodos no se podían guardar** — Postgres los rechazaba y el editor
-- habría fallado en silencio al añadirlos.
--
-- Se rehace el CHECK con todos los tipos que el motor sabe ejecutar.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
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
    'end'
  ));
