/**
 * Traduce un flujo de Leona (el JSON de su `get_flow`: flow + nodes +
 * connections) a nodos del WaCRM, para importarlo completo: bloques,
 * textos, archivos, posiciones y TODAS las líneas.
 *
 * Formato de Leona (leído de flujos reales el 27-nov-2026):
 *   node = { id, node_type, position:{x,y}, actions:[{action_type, config, order}] }
 *   connection = { from_node_id, to_node_id, condition_type, condition_config }
 *     - condition_config.condition_result: success | failure | charge_created |
 *       payment_approved | error
 *     - condition_config.response_type / source_handle: client-response | timeout
 *     - menu_option + option_id / option_index; menu_other; menu_timeout
 *     - condition_config.output_id (distribuidor) · output_key (IA)
 *
 * Variables: Leona usa {campo}; el WaCRM usa {{vars.campo}} y
 * {{contact.name}}. Lo que no tiene equivalente se importa como bloque de
 * paso (Intervalo de 0 s) para no cortar las líneas, y se avisa.
 *
 * Funciones puras: las etiquetas se resuelven fuera (por nombre → id).
 */

export interface LeonaAccion {
  action_type: string;
  config?: Record<string, unknown> | null;
  order?: number | null;
}

export interface LeonaNodo {
  id: number | string;
  node_type: string;
  name?: string | null;
  position?: { x?: number; y?: number } | null;
  actions?: LeonaAccion[] | null;
}

export interface LeonaConexion {
  from_node_id: number | string;
  to_node_id: number | string;
  condition_type?: string | null;
  condition_config?: Record<string, unknown> | null;
}

export interface LeonaFlujo {
  flow?: { name?: string; description?: string | null; start_node?: { id?: number | string } | null } | null;
  nodes: LeonaNodo[];
  connections?: LeonaConexion[] | null;
}

export interface NodoImportado {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

export interface FlujoImportado {
  name: string;
  description: string | null;
  trigger_type: 'first_inbound_message';
  trigger_config: Record<string, unknown>;
  entry_node_id: string;
  nodes: NodoImportado[];
  /** Lo que no se pudo traducir 1:1 (para mostrarlo al importar). */
  avisos: string[];
}

/** ¿Parece un flujo de Leona? */
export function esFlujoLeona(x: unknown): x is LeonaFlujo {
  if (!x || typeof x !== 'object') return false;
  const nodos = (x as { nodes?: unknown }).nodes;
  return (
    Array.isArray(nodos) &&
    nodos.length > 0 &&
    nodos.every(
      (n) =>
        n &&
        typeof n === 'object' &&
        'node_type' in (n as object) &&
        'actions' in (n as object),
    )
  );
}

/** Nombres de etiqueta que usa el flujo (para crearlas/buscarlas antes). */
export function etiquetasDelFlujo(f: LeonaFlujo): string[] {
  const nombres = new Set<string>();
  for (const n of f.nodes) {
    for (const a of n.actions ?? []) {
      const c = a.config ?? {};
      if (a.action_type === 'add_tags' || a.action_type === 'remove_tags') {
        for (const t of (c.tags as unknown[]) ?? []) {
          const nombre = typeof t === 'string' ? t : (t as { name?: string })?.name;
          if (nombre?.trim()) nombres.add(nombre.trim());
        }
      }
      if (a.action_type === 'evaluate_condition') {
        for (const r of (c.conditions as Array<Record<string, unknown>>) ?? []) {
          if (r.systemSubtype === 'tag' && typeof r.tagName === 'string' && r.tagName.trim()) {
            nombres.add(r.tagName.trim());
          }
        }
      }
    }
  }
  return [...nombres];
}

// ------------------------------------------------------------
// Variables
// ------------------------------------------------------------

const VARIABLES_CONTACTO: Record<string, string> = {
  full_name: '{{contact.name}}',
  name: '{{contact.name}}',
  first_name: '{{contact.name}}',
  'customer.name': '{{contact.name}}',
  phone_number: '{{contact.phone}}',
  phone: '{{contact.phone}}',
  'customer.phone': '{{contact.phone}}',
  email: '{{contact.email}}',
  'customer.email': '{{contact.email}}',
  last_message: '{{last_user_message}}',
};

/** Nombre de variable válido para {{vars.x}}. */
function claveVar(nombre: string): string {
  return nombre.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'valor';
}

/** {full_name} → {{contact.name}} · {resposta} → {{vars.resposta}}. */
export function convertirVariables(texto: string): string {
  if (!texto) return '';
  return texto.replace(/(?<!\{)\{([a-zA-Z_][\w.]*)\}(?!\})/g, (_, nombre: string) => {
    const fijo = VARIABLES_CONTACTO[nombre.toLowerCase()];
    if (fijo) return fijo;
    const limpio = nombre.replace(/^(customer\.custom\.|custom\.|global\.)/, '');
    return `{{vars.${claveVar(limpio)}}}`;
  });
}

/** «{gateway.value}» → «gateway_value» (para campos que piden el nombre). */
function nombreDeVariable(plantilla: unknown): string {
  const s = String(plantilla ?? '').trim();
  const m = s.match(/^\{([\w.]+)\}$/);
  return claveVar(m ? m[1] : s);
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

const UNIDAD_SEG: Record<string, number> = {
  seconds: 1,
  second: 1,
  minutes: 60,
  minute: 60,
  hours: 3600,
  hour: 3600,
  days: 86400,
  day: 86400,
};

function segundos(valor: unknown, unidad: unknown): number {
  const v = Number(valor) || 0;
  return Math.max(0, Math.round(v * (UNIDAD_SEG[String(unidad ?? 'minutes')] ?? 60)));
}

function numero(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/\s/g, '');
  // «100,00» (coma decimal) o «1.234,50».
  const normal = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(normal);
  return Number.isFinite(n) ? n : 0;
}

function urlDeMedio(c: Record<string, unknown>): string {
  const info = (c.media_file_info ?? {}) as { url?: string; direct_url?: string };
  return String(info.url || info.direct_url || c.file_url || c.media_url || c.url || '');
}

function nombreDeArchivo(c: Record<string, unknown>): string | undefined {
  const info = (c.media_file_info ?? {}) as { filename?: string };
  const n = info.filename || c.file_name || c.filename;
  return typeof n === 'string' && n ? n : undefined;
}

const recorta = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

// ------------------------------------------------------------
// Conversión
// ------------------------------------------------------------

export function convertirFlujoLeona(
  leona: LeonaFlujo,
  opciones: { tagId: (nombre: string) => string | null },
): FlujoImportado {
  const avisos: string[] = [];
  const nodos = leona.nodes ?? [];
  const startId = String(
    leona.flow?.start_node?.id ?? nodos.find((n) => n.node_type === 'start')?.id ?? '',
  );
  const clave = (id: number | string) => (String(id) === startId ? 'start' : `n${id}`);

  // Conexiones por nodo de origen (vienen sueltas o dentro de cada nodo).
  const salidas = new Map<string, LeonaConexion[]>();
  const todas: LeonaConexion[] = [...(leona.connections ?? [])];
  if (todas.length === 0) {
    for (const n of nodos) {
      for (const c of ((n as unknown as { connections?: LeonaConexion[] }).connections ?? [])) {
        todas.push({ ...c, from_node_id: n.id });
      }
    }
  }
  const existentes = new Set(nodos.map((n) => String(n.id)));
  for (const c of todas) {
    if (!existentes.has(String(c.to_node_id))) continue;
    const k = String(c.from_node_id);
    salidas.set(k, [...(salidas.get(k) ?? []), c]);
  }
  const destino = (c: LeonaConexion | undefined) => (c ? clave(c.to_node_id) : '');
  const resultado = (c: LeonaConexion) =>
    String(
      c.condition_config?.condition_result ??
        c.condition_config?.response_type ??
        c.condition_config?.source_handle ??
        c.condition_type ??
        '',
    );
  const buscar = (lista: LeonaConexion[], ...valores: string[]) =>
    lista.find((c) => valores.includes(resultado(c)));
  const primera = (lista: LeonaConexion[]) =>
    lista.find((c) => !c.condition_config?.condition_result) ?? lista[0];

  const salida: NodoImportado[] = [];

  for (const n of nodos) {
    const key = clave(n.id);
    const acciones = [...(n.actions ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const accion = (tipo: string) => acciones.find((a) => a.action_type === tipo)?.config ?? {};
    const sal = salidas.get(String(n.id)) ?? [];
    const pos = { position_x: Math.round(n.position?.x ?? 0), position_y: Math.round(n.position?.y ?? 0) };
    const empujar = (node_type: string, config: Record<string, unknown>) =>
      salida.push({ node_key: key, node_type, config, ...pos });
    const paso = (motivo: string) => {
      avisos.push(motivo);
      empujar('wait', { modo: 'intervalo', segundos: 0, next_node_key: destino(primera(sal)) });
    };

    switch (n.node_type) {
      case 'start':
        empujar('start', { next_node_key: destino(primera(sal)) });
        break;

      case 'message': {
        const items: Array<Record<string, unknown>> = [];
        for (const a of acciones) {
          const c = a.config ?? {};
          switch (a.action_type) {
            case 'send_message':
              items.push({
                tipo: 'text',
                text: convertirVariables(String(c.message_text ?? c.message ?? '')),
                segundos: Math.min(60, Number(c.typing_delay_seconds) || 0),
              });
              break;
            case 'delay_between_messages':
              items.push({
                tipo: 'interval',
                segundos: Math.round(
                  (Number(c.delay_min_seconds ?? c.delay_seconds) + Number(c.delay_max_seconds ?? c.delay_seconds)) / 2,
                ) || Number(c.delay_seconds) || 0,
              });
              break;
            case 'send_file':
              items.push({ tipo: 'document', media_url: urlDeMedio(c), filename: nombreDeArchivo(c) });
              break;
            case 'send_sticker':
              items.push({ tipo: 'sticker', media_url: urlDeMedio(c) });
              break;
            case 'send_multi_media': {
              const tipo = String(c.media_type ?? '');
              const medio = ['image', 'video', 'audio'].includes(tipo) ? tipo : 'document';
              items.push({
                tipo: medio,
                media_url: urlDeMedio(c),
                filename: nombreDeArchivo(c),
                segundos: Math.min(60, Number(c.typing_delay_seconds) || 0),
                ...(typeof c.caption === 'string' && c.caption ? { text: convertirVariables(c.caption) } : {}),
              });
              break;
            }
            case 'send_contact':
              avisos.push(`Mensaje ${key}: la tarjeta de contacto se pasó a texto.`);
              items.push({
                tipo: 'text',
                text: [c.contact_name ?? c.name, c.contact_phone ?? c.phone].filter(Boolean).join(' · '),
              });
              break;
            default:
              avisos.push(`Mensaje ${key}: «${a.action_type}» no tiene equivalente y se omitió.`);
          }
        }
        const primerTexto = items.find((i) => i.tipo === 'text')?.text;
        empujar('send_message', {
          text: typeof primerTexto === 'string' ? primerTexto : '',
          items,
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'interactive_menu':
      case 'menu': {
        const c = accion(n.node_type === 'menu' ? 'send_option_list' : 'send_interactive_menu') as Record<string, unknown>;
        const opciones = ((c.options as Array<Record<string, unknown>>) ?? []).map((o, i) => ({
          id: String(o.id ?? `op_${i + 1}`),
          title: String(o.title ?? `Opción ${i + 1}`),
          description: typeof o.description === 'string' ? o.description : '',
          index: i,
        }));
        const destinoOpcion = (o: { id: string; index: number }) =>
          destino(
            sal.find(
              (x) =>
                x.condition_config?.option_id === o.id ||
                (x.condition_type === 'menu_option' && Number(x.condition_config?.option_index) === o.index),
            ),
          );
        const texto = convertirVariables(String(c.message ?? c.text ?? ''));
        const pie = typeof c.footerText === 'string' && c.footerText ? c.footerText : undefined;
        if (sal.some((x) => x.condition_type === 'menu_other' || x.condition_type === 'menu_timeout')) {
          avisos.push(`Menú ${key}: las salidas «otra respuesta» y «sin respuesta» no se importan.`);
        }
        if (opciones.length <= 3 && c.menuType !== 'list') {
          const usados = new Set<string>();
          empujar('send_buttons', {
            text: texto,
            ...(pie ? { footer_text: pie } : {}),
            buttons: opciones.map((o) => {
              let rid = o.id;
              while (usados.has(rid)) rid += '_';
              usados.add(rid);
              return { reply_id: rid, title: recorta(o.title, 20), next_node_key: destinoOpcion(o) };
            }),
          });
        } else {
          if (opciones.length > 10) avisos.push(`Menú ${key}: tenía ${opciones.length} opciones; WhatsApp permite 10.`);
          empujar('send_list', {
            text: texto,
            button_label: recorta(String(c.buttonText ?? c.button_label ?? 'Ver opciones'), 20),
            ...(pie ? { footer_text: pie } : {}),
            sections: [
              {
                rows: opciones.slice(0, 10).map((o) => ({
                  reply_id: o.id,
                  title: recorta(o.title, 24),
                  ...(o.description ? { description: recorta(o.description, 72) } : {}),
                  next_node_key: destinoOpcion(o),
                })),
              },
            ],
          });
        }
        break;
      }

      case 'wait_response': {
        const pregunta = accion('send_message');
        const espera = accion('wait_for_response');
        const guardar = accion('save_user_data');
        const indefinido = Boolean(espera.wait_indefinitely);
        const seg = segundos(espera.timeout_value, espera.timeout_unit);
        empujar('save_reply', {
          prompt_text: convertirVariables(String(pregunta.message ?? pregunta.message_text ?? '')),
          var_key: claveVar(String(guardar.field_name ?? 'resposta')),
          esperar_indefinido: indefinido || seg === 0,
          espera_segundos: seg,
          espera_minutos: Math.round(seg / 60),
          buffer_segundos: espera.buffer_enabled ? Math.min(120, Number(espera.buffer_value) || 0) : 0,
          reaccionar: Boolean(espera.react_to_lead_check_enabled),
          citar_respuesta: Boolean(espera.reply_to_lead_enabled),
          contesto_next: destino(buscar(sal, 'client-response')),
          no_contesto_next: destino(buscar(sal, 'timeout')),
        });
        break;
      }

      case 'condition': {
        const c = accion('evaluate_condition');
        const reglas: Array<Record<string, unknown>> = [];
        for (const [i, r] of ((c.conditions as Array<Record<string, unknown>>) ?? []).entries()) {
          const id = String(r.id ?? `r${i + 1}`);
          if (r.systemSubtype === 'tag' || r.category === 'tag') {
            const tag = opciones.tagId(String(r.tagName ?? ''));
            if (!tag) {
              avisos.push(`Condicional ${key}: no se encontró la etiqueta «${r.tagName}».`);
              continue;
            }
            const op = String(r.systemOperator ?? r.operator ?? 'equal');
            reglas.push({
              id,
              subject: 'tag',
              subject_key: tag,
              operator: op.startsWith('not') || op === 'different' ? 'absent' : 'present',
            });
          } else if (r.category === 'custom_field' || r.fieldName) {
            const op = String(r.fieldOperator ?? 'equal');
            const valor = String(r.fieldValue ?? '');
            if (op === 'type') {
              avisos.push(`Condicional ${key}: «tipo de respuesta = ${valor}» se aproximó a «tiene respuesta».`);
            }
            reglas.push({
              id,
              subject: 'var',
              subject_key: claveVar(String(r.fieldName ?? '')),
              operator:
                op === 'contains' ? 'contains' : op === 'type' || op === 'exists' ? 'present' : op === 'empty' ? 'absent' : 'equals',
              ...(op === 'type' || op === 'exists' || op === 'empty' ? {} : { value: valor }),
            });
          } else {
            avisos.push(`Condicional ${key}: una regla de tipo «${r.category ?? r.systemSubtype}» no se pudo traducir.`);
          }
        }
        const base = reglas[0] ?? { subject: 'var', subject_key: 'respuesta', operator: 'present' };
        empujar('condition', {
          logic: c.ruleType === 'any' ? 'any' : 'all',
          rules: reglas,
          subject: base.subject,
          subject_key: base.subject_key,
          operator: base.operator,
          ...(base.value !== undefined ? { value: base.value } : {}),
          true_next: destino(buscar(sal, 'success')),
          false_next: destino(buscar(sal, 'failure')),
        });
        break;
      }

      case 'tags': {
        const a = acciones[0];
        const c = a?.config ?? {};
        const nombres = ((c.tags as unknown[]) ?? [])
          .map((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name ?? ''))
          .filter(Boolean);
        const ids = nombres.map((t) => opciones.tagId(t)).filter((x): x is string => Boolean(x));
        if (ids.length < nombres.length) avisos.push(`Etiquetas ${key}: alguna etiqueta no se pudo crear.`);
        empujar('set_tag', {
          mode: a?.action_type === 'remove_tags' || c.action === 'remove' ? 'remove' : 'add',
          tag_ids: ids,
          tag_id: ids[0] ?? '',
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'smart_interval': {
        const c = accion('smart_interval');
        if (c.schedule_type === 'date' && c.scheduled_date) {
          empujar('wait', { modo: 'fecha', fecha_objetivo: String(c.scheduled_date), next_node_key: destino(primera(sal)) });
        } else {
          empujar('wait', {
            modo: 'intervalo',
            segundos: segundos(c.interval_value, c.interval_unit),
            next_node_key: destino(primera(sal)),
          });
        }
        break;
      }

      case 'notification': {
        const c = accion('send_notification');
        empujar('notification', {
          name: String(c.name ?? 'Equipo'),
          country_code: String(c.country_code ?? '52'),
          phone: String(c.phone ?? ''),
          message: convertirVariables(String(c.message ?? '')),
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'ai': {
        const c = accion('ai_call');
        const condiciones = ((c.output_conditions as Array<Record<string, unknown>>) ?? [])
          .map((o, i) => {
            const id = claveVar(String(o.key ?? o.output_key ?? o.id ?? `c${i + 1}`));
            return {
              id,
              label: String(o.label ?? o.description ?? id),
              next_node_key: destino(sal.find((x) => x.condition_config?.output_key === (o.key ?? o.output_key ?? o.id))),
            };
          })
          .filter((x) => x.id !== 'fallback');
        const recibo = sal.find((x) => x.condition_config?.output_key === 'comprovante');
        const resto =
          buscar(sal, 'success') ??
          sal.find((x) => x.condition_config?.output_key === (c.fallback_output_key ?? 'fallback'));
        if (buscar(sal, 'failure')) avisos.push(`Bloque de IA ${key}: la salida «falla» no existe aquí; sigue por la principal.`);
        if (typeof c.api_key === 'string' && c.api_key) {
          avisos.push(`Bloque de IA ${key}: usa la IA configurada en el WaCRM (la clave de Leona no se copia).`);
        }
        empujar('ai_block', {
          credential_source: 'account',
          model: typeof c.model === 'string' ? c.model : undefined,
          prompt: convertirVariables(String(c.system_prompt ?? '')),
          message_template: convertirVariables(String(c.user_message ?? '')),
          output_var: claveVar(String(c.response_variable ?? 'ai_response')),
          auto_send: c.auto_send_response !== false,
          understand_audio: Boolean(c.understand_audio),
          understand_image: Boolean(c.understand_image),
          understand_pdf: Boolean(c.understand_pdf),
          identify_receipt: Boolean(c.understand_receipt) || Boolean(recibo),
          context_window: Number(c.context_interactions) || 10,
          conditions: condiciones,
          ...(recibo ? { receipt_next: destino(recibo) } : {}),
          fallback_next: destino(resto ?? buscar(sal, 'failure')),
        });
        break;
      }

      case 'payment':
      case 'leonapay': {
        const c = accion('create_payment_charge');
        const monto = numero(c.amount);
        const moneda = String(c.currency ?? 'MXN').toUpperCase() === 'USD' ? 'USD' : 'MXN';
        const creado = buscar(sal, 'charge_created');
        if (creado) {
          avisos.push(
            `Pago ${key}: la salida «cobro generado» de Leona no existe aquí; revisa el mensaje con los datos de pago.`,
          );
        }
        empujar('payment_gateway', {
          provider: 'spei',
          currency: moneda,
          amount_mode: c.open_amount ? 'variable' : 'fixed',
          amount: monto,
          ...(c.open_amount ? { amount_var: 'monto' } : {}),
          wait_minutes: Math.max(1, Math.round(segundos(c.listener_ttl_value ?? 1, c.listener_ttl_unit ?? 'days') / 60)),
          approved_next: destino(buscar(sal, 'payment_approved')),
          rejected_next: destino(buscar(sal, 'error')),
          send_capi: true,
          notify: true,
        });
        break;
      }

      case 'approved_sale': {
        const c = accion('register_approved_sale');
        empujar('sale_approved', {
          pipeline_id: '',
          stage_id: '',
          amount_var: nombreDeVariable(c.amount_template ?? 'monto'),
          currency_var: String(c.currency_template ?? 'MXN'),
          name_var: nombreDeVariable(c.customer_name_template ?? ''),
          send_capi: true,
          notify: true,
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'pixel': {
        const c = accion('send_pixel_event');
        const evento = String(c.event_type ?? 'Lead');
        const valor = numero(c.item_value);
        empujar('meta_capi', {
          event_name: evento === 'Compra' || evento === 'Purchase' ? 'Purchase' : 'Lead',
          ...(valor ? { value: valor } : {}),
          ...(c.currency ? { currency: String(c.currency) } : {}),
          next_node_key: destino(primera(sal)),
        });
        avisos.push(`Pixel ${key}: elige el píxel de Meta de esta cuenta en el bloque.`);
        break;
      }

      case 'distributor': {
        const c = accion('distribute_contacts');
        const outs = ((c.outputs as Array<Record<string, unknown>>) ?? []).map((o, i) => {
          const id = String(o.id ?? `out_${i + 1}`);
          return {
            id,
            label: String(o.label ?? `Camino ${i + 1}`),
            next_node_key: destino(sal.find((x) => x.condition_config?.output_id === id)),
          };
        });
        empujar('distributor', { mode: 'always_next', outputs: outs });
        break;
      }

      case 'connection_flow': {
        const c = accion('execute_flow');
        avisos.push(
          `Conexión de flujo ${key}: apunta a «${c.target_flow_name ?? c.target_flow_id}» de Leona; elige el flujo de aquí.`,
        );
        empujar('connect_flow', { target_flow_id: '' });
        break;
      }

      case 'chat_controller': {
        const c = accion('change_chat_status');
        const estado = String(c.chat_status ?? '');
        if (sal.length) avisos.push(`Controlador de chat ${key}: aquí termina el flujo (en el WaCRM no sigue después).`);
        empujar('handoff', {
          status: estado === 'Resolvidos' ? 'closed' : estado === 'Atendimento' ? 'open' : 'pending',
        });
        break;
      }

      case 'ai_agent': {
        const c = accion('control_ai_agent');
        if (sal.length) avisos.push(`Agente de IA ${key}: aquí termina el flujo (en el WaCRM no sigue después).`);
        if (c.mode === 'deactivate') {
          empujar('handoff', { pause_ai: true });
        } else {
          empujar('end', {});
        }
        break;
      }

      case 'department': {
        const c = accion('set_department');
        avisos.push(`Departamento ${key}: elige el departamento de esta cuenta.`);
        empujar('department', {
          department_id: '',
          department_name: String(c.department_name ?? ''),
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'kanban': {
        avisos.push(`Kanban ${key}: elige el tablero y la columna de esta cuenta.`);
        empujar('move_kanban', {
          pipeline_id: '',
          stage_id: '',
          crear_si_no_existe: true,
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'manipulator': {
        const a = acciones[0];
        const c = a?.config ?? {};
        if (a?.action_type === 'set_contact_custom_field') {
          const op = String(c.operation ?? c.math_operation ?? 'set');
          empujar('manipulator', {
            target: 'var',
            key: claveVar(String(c.field_name ?? c.custom_field_name ?? c.field ?? 'campo')),
            operation: op === 'add' || op === 'sum' ? 'add' : op === 'subtract' ? 'subtract' : op === 'clear' ? 'clear' : 'set',
            value: convertirVariables(String(c.value ?? '')),
            next_node_key: destino(primera(sal)),
          });
        } else {
          paso(`Manipulador ${key}: «${a?.action_type}» no tiene equivalente; queda como paso.`);
        }
        break;
      }

      case 'integration': {
        const c = accion('make_http_request');
        const metodo = String(c.request_method ?? 'GET').toUpperCase();
        empujar('http_request', {
          method: ['GET', 'POST', 'PUT', 'DELETE'].includes(metodo) ? metodo : 'POST',
          url: convertirVariables(String(c.request_url ?? '')),
          headers: Object.entries((c.request_headers as Record<string, string>) ?? {}).map(([k, v]) => ({
            key: k,
            value: convertirVariables(String(v)),
          })),
          body_type: c.request_body ? 'json' : 'none',
          ...(c.request_body ? { body: convertirVariables(typeof c.request_body === 'string' ? c.request_body : JSON.stringify(c.request_body)) } : {}),
          response_map: [],
          next_node_key: destino(buscar(sal, 'success') ?? primera(sal)),
          ...(buscar(sal, 'failure') ? { error_next: destino(buscar(sal, 'failure')) } : {}),
        });
        break;
      }

      case 'template': {
        const c = accion('send_template');
        if (sal.length > 1) avisos.push(`Template ${key}: las salidas por botón no se importan; sigue por la principal.`);
        empujar('send_template', {
          template_name: String(c.template_name ?? c.name ?? ''),
          language: String(c.language ?? c.template_language ?? 'es_MX'),
          variables: {},
          next_node_key: destino(primera(sal)),
        });
        break;
      }

      case 'carousel': {
        const c = accion('send_carousel');
        const tarjetas = ((c.carousel as Array<Record<string, unknown>>) ?? []).map((t, i) => ({
          id: `card_${i + 1}`,
          text: convertirVariables(String(t.text ?? t.body ?? '')),
          image_url: String(t.media_url ?? t.image_url ?? t.url ?? ''),
          buttons: ((t.buttons as Array<Record<string, unknown>>) ?? []).map((b, j) => ({
            id: String(b.id ?? `b${i + 1}_${j + 1}`),
            label: String(b.label ?? b.text ?? b.title ?? 'Ver'),
            type: b.type === 'URL' || b.url ? 'url' : 'reply',
            ...(b.url ? { url: String(b.url) } : {}),
          })),
        }));
        avisos.push(`Carrusel ${key}: revisa los botones y sus salidas.`);
        empujar('carousel', {
          intro_text: convertirVariables(String(c.text ?? '')),
          expires_days: 1,
          cards: tarjetas,
        });
        break;
      }

      default:
        paso(`Bloque «${n.node_type}» (${key}) no existe en el WaCRM; queda como paso para no cortar el flujo.`);
    }
  }

  if (!salida.some((n) => n.node_type === 'start')) {
    salida.unshift({ node_key: 'start', node_type: 'start', config: { next_node_key: salida[0]?.node_key ?? '' }, position_x: 0, position_y: 0 });
  }

  return {
    name: (leona.flow?.name?.trim() || 'Flujo de Leona').slice(0, 120),
    description: leona.flow?.description ?? null,
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    entry_node_id: 'start',
    nodes: salida,
    avisos: [...new Set(avisos)],
  };
}
