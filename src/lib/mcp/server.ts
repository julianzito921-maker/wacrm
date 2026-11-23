import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from './auth';
import { McpToolError } from './errors';
import {
  auditFunnelPerformance,
  deployCompleteFunnel,
  getWorkspaceContext,
  inspectAndReplyContact,
  manageCrmEntities,
} from './tools';
import type { FriendlyNode } from './normalizer';

function response(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function guard(fn: () => Promise<unknown>) {
  try {
    return response(await fn());
  } catch (err) {
    const message =
      err instanceof McpToolError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Error inesperado';
    if (!(err instanceof McpToolError)) {
      console.error('[mcp] tool failed:', err);
    }
    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }
}

export function createMcpServer(ctx: McpAuthContext): McpServer {
  const server = new McpServer({ name: 'wacrm', version: '1.0.0' });

  server.registerTool(
    'get_workspace_context',
    {
      title: 'Workspace context',
      description:
        'Returns the account funnel(s), stages, tags, custom fields, APPROVED templates, SPEI payment summary (CLABE masked), Meta pixel/purchase stage and existing flows. Call this FIRST before deploying so you can use names instead of UUIDs.',
      inputSchema: {},
    },
    async () => guard(() => getWorkspaceContext(ctx)),
  );

  server.registerTool(
    'deploy_complete_funnel',
    {
      title: 'Deploy a complete funnel',
      description: `Creates or updates a full WhatsApp flow. It normalizes friendly nodes, resolves names to IDs, auto-generates node keys/links, runs the activation validator and saves atomically only if there are no errors.

Node examples (array order = default flow):
- {type:"start"}
- {type:"message", messages:[{type:"text",text:"Hola"},{type:"image",url:"https://...",caption:"Mira"},{type:"interval",seconds:5}]}
- {type:"wait", duration:"2m"}
- {type:"wait_reply", var:"respuesta", prompt:"¿Te ayudo?", wait:"1d", no_reply_next:"fin"}
- {type:"payment", amount:499, approved_next:"pagado", rejected_next:"fin"}
- {type:"kanban", pipeline:"Ventas", stage:"Pagado"}
- {type:"capi", event:"Purchase", value:499}
- {type:"tag", tag:"cliente"}
- {type:"template", template:"bienvenida", variables:{"1":"Ana"}}
- {type:"end"}

Use key/next only for branches; otherwise nodes link in order. Indexes are 0-based. activate=false keeps it as draft.`,
      inputSchema: {
        flow_id: z.string().optional().describe('Existing flow UUID to replace.'),
        name: z.string().describe('Flow name.'),
        trigger: z
          .object({
            type: z
              .enum(['keyword', 'first_inbound_message', 'any_message'])
              .optional(),
            keywords: z.array(z.string()).optional(),
            match_type: z.enum(['contains', 'exact']).optional(),
          })
          .optional(),
        nodes: z.array(z.record(z.string(), z.unknown())).min(1),
        activate: z.boolean().optional(),
      },
    },
    async (args) =>
      guard(() =>
        deployCompleteFunnel(ctx, {
          ...args,
          nodes: args.nodes as unknown as FriendlyNode[],
        }),
      ),
  );

  server.registerTool(
    'audit_funnel_performance',
    {
      title: 'Audit funnel performance',
      description:
        'Returns the flow structure plus real per-node entries, exits, conversion rate and active runs (last N days, default 30). Use it to find drop-offs before optimizing.',
      inputSchema: {
        flow_id: z.string().optional(),
        flow_name: z.string().optional(),
        days: z.number().min(1).max(365).optional(),
      },
    },
    async (args) => guard(() => auditFunnelPerformance(ctx, args)),
  );

  server.registerTool(
    'manage_crm_entities',
    {
      title: 'Manage CRM entities',
      description: `Create or edit pipelines, stages, tags, custom fields and deals. Actions:
pipeline_create {name}
pipeline_rename {pipeline,new_name}
stage_create {pipeline,name,position?,color?}
stage_update {pipeline,stage,name?,position?,color?}
stage_reorder {pipeline,order:[names]}
tag_create {name,color?}
tag_rename {tag,new_name}
field_create {name,type?,options?}
deal_create {pipeline,stage,contact_id|phone|contact_name,title?,value?,currency?,notes?}
deal_update {deal_id,title?,value?,notes?,status?}
deal_move {deal_id,pipeline?,stage}
Names are accepted instead of UUIDs. Moving a deal to the Meta purchase stage fires Purchase.`,
      inputSchema: {
        action: z.string(),
        name: z.string().optional(),
        new_name: z.string().optional(),
        pipeline: z.string().optional(),
        stage: z.string().optional(),
        order: z.array(z.string()).optional(),
        position: z.number().optional(),
        color: z.string().optional(),
        tag: z.string().optional(),
        type: z.string().optional(),
        options: z.unknown().optional(),
        deal_id: z.string().optional(),
        contact_id: z.string().optional(),
        phone: z.string().optional(),
        contact_name: z.string().optional(),
        title: z.string().optional(),
        value: z.number().optional(),
        currency: z.string().optional(),
        notes: z.string().optional(),
        status: z.string().optional(),
      },
    },
    async (args) => guard(() => manageCrmEntities(ctx, args)),
  );

  server.registerTool(
    'inspect_and_reply_contact',
    {
      title: 'Inspect and reply to a contact',
      description: `Actions:
search {query} — find contacts by name/phone (needs read).
history {contact_id|phone|name,limit?} — messages, notes, payment receipts (OCR), tags, deals, attribution and flow runs (needs read).
pause_flows {contact_id|phone|name} — pauses active runs (paused_by_agent) and turns AI off for the chat (needs write_flows).
resume_flows {contact_id|phone|name} — re-enables AI; the next inbound may start a new run (needs write_flows).
send_text {contact_id|phone|name,text} — sends via WhatsApp (needs send_messages).
send_template {contact_id|phone|name,template,language?,variables:[...]} — sends an APPROVED template (needs send_messages).`,
      inputSchema: {
        action: z.string(),
        query: z.string().optional(),
        contact_id: z.string().optional(),
        phone: z.string().optional(),
        name: z.string().optional(),
        limit: z.number().min(1).max(100).optional(),
        text: z.string().optional(),
        template: z.string().optional(),
        language: z.string().optional(),
        variables: z.array(z.union([z.string(), z.number()])).optional(),
      },
    },
    async (args) => guard(() => inspectAndReplyContact(ctx, args)),
  );

  return server;
}
