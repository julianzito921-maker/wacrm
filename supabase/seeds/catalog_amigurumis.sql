-- ============================================================
-- Catálogo de productos · Pack 150 Amigurumis de Navidad
--
-- Se puede correr varias veces (ON CONFLICT por cuenta + clave).
-- Se carga para cada cuenta que tenga una configuración de WhatsApp
-- conectada, así el archivo no guarda identificadores de ninguna cuenta
-- concreta y vale igual en local, en CI y en producción.
--
-- Reglas de negocio que viajan aquí:
--   · aporte_voluntario = true  → el agente nunca dice un precio fijo,
--     solo los valores de referencia.
--   · `incluye` es lo que el agente puede prometer; nada más.
--   · `notas` corrige el error típico ("¿viene el hilo?").
-- ============================================================

INSERT INTO product_catalog (
  account_id, clave, nombre, precio, moneda, aporte_voluntario,
  valores_sugeridos, incluye, notas, activo, orden
)
SELECT
  a.id,
  'pack',
  'Pack 150 Amigurumis de Navidad',
  NULL,
  'MXN',
  true,
  ARRAY[100, 150, 200, 300]::numeric[],
  ARRAY[
    '150 patrones de amigurumis navideños con instrucciones paso a paso',
    'Bono 1 · ABC del amigurumi',
    'Bono 2 · 12 adornos rápidos para el árbol',
    'Bono 3 · Empaca y regala',
    'Bono 4 · Plan de 14 días y errores comunes'
  ],
  'Material digital en PDF, se entrega al momento. No incluye hilo, ganchillo ni piezas tejidas. No tiene precio fijo: es un aporte voluntario y la persona decide cuánto aporta.',
  true,
  1
FROM accounts a
WHERE EXISTS (
  SELECT 1 FROM whatsapp_config w WHERE w.account_id = a.id
)
ON CONFLICT (account_id, clave) DO UPDATE SET
  nombre            = EXCLUDED.nombre,
  precio            = EXCLUDED.precio,
  moneda            = EXCLUDED.moneda,
  aporte_voluntario = EXCLUDED.aporte_voluntario,
  valores_sugeridos = EXCLUDED.valores_sugeridos,
  incluye           = EXCLUDED.incluye,
  notas             = EXCLUDED.notas,
  activo            = EXCLUDED.activo,
  orden             = EXCLUDED.orden,
  updated_at        = NOW();

-- Comprobación rápida
-- SELECT clave, nombre, aporte_voluntario, valores_sugeridos FROM product_catalog ORDER BY orden;
