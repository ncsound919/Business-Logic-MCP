#!/usr/bin/env node
/**
 * Business Logic MCP Server
 * A single-file MCP server that exposes business rules, state machines,
 * field semantics, and known footguns to LLMs during code generation.
 *
 * Usage:
 *   # Using the installed CLI (recommended)
 *   npx business-logic-mcp
 *
 *   # From source with ts-node
 *   npx ts-node src/index.ts
 *
 *   # Or compile then run the built JS
 *   npx tsc && node dist/index.js
 *
 * Add to your MCP client config:
 *   { "command": "business-logic-mcp", "args": [] }
 *   # or, if pointing directly at the compiled file:
 *   { "command": "node", "args": ["path/to/dist/index.js"] }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// BUSINESS LOGIC STORE
// Edit this JSON to define your domain's rules, entities, and constraints.
// =============================================================================

const BUSINESS_LOGIC: BusinessLogicStore = {
  meta: {
    project: "My App",
    version: "1.0.0",
    last_updated: "2025-02-23",
    owner: "engineering@myapp.com",
  },

  entities: {
    Order: {
      description: "A customer purchase request containing one or more items.",
      fields: {
        status: {
          type: "enum",
          values: ["draft", "pending", "confirmed", "shipped", "delivered", "cancelled", "refunded"],
          notes: "Never manually set to 'refunded' — always go through the refund service.",
        },
        total_amount: {
          type: "number",
          notes: "Stored in cents (integer). Never store as float. Display layer divides by 100.",
        },
        marketplace_seller_id: {
          type: "string | null",
          notes: "Null means fulfilled by us. Non-null changes shipping threshold and tax rules.",
          deprecated: false,
        },
        legacy_promo_code: {
          type: "string | null",
          deprecated: true,
          replacement: "discount_ids (array)",
          notes: "Still read by iOS < 14 clients. Do not remove column, but never write to it in new code.",
        },
      },
      rules: [
        "Free shipping threshold is $50 for first-party orders, $75 for marketplace sellers.",
        "During flash sales (check feature flag 'flash_sale_active'), threshold drops to $20 for all.",
        "Orders cannot be cancelled once status is 'shipped' — use refund flow instead.",
        "Tax is only calculated on items, never on shipping costs.",
        "A single order cannot contain both digital and physical items — split at checkout.",
      ],
      side_effects: [
        "Any status change must emit an 'order.status_changed' event to the event bus.",
        "Cancellation triggers inventory re-stocking job (async, do not await).",
        "Confirmed orders sync to the ERP system within 30s via order-sync-worker.",
      ],
      known_footguns: [
        "Do NOT use `updated_at` to detect status changes — use the order_events audit table.",
        "Summing item prices from the items table will NOT match total_amount due to historical discount application differences. Always trust total_amount on the order row.",
        "The `notes` field is customer-visible. Never write internal/debug info there.",
      ],
    },

    User: {
      description: "Represents an authenticated account, either consumer or internal admin.",
      fields: {
        email: {
          type: "string",
          notes: "Canonical identity. Changing it requires re-verification and CRM sync.",
        },
        role: {
          type: "enum",
          values: ["consumer", "seller", "support", "admin"],
          notes: "'support' can view but not modify orders. 'admin' has no restrictions.",
        },
        deleted_at: {
          type: "timestamp | null",
          notes: "Soft delete. All queries MUST filter WHERE deleted_at IS NULL unless explicitly auditing.",
        },
        stripe_customer_id: {
          type: "string | null",
          notes: "Created lazily on first payment. Never create a Stripe customer manually — use UserBillingService.",
        },
      },
      rules: [
        "Email must be lowercase before storage. Enforce at DB constraint AND application layer.",
        "A deleted user's orders and data must be retained for 7 years (legal requirement).",
        "Admins cannot delete other admins — only superadmins can.",
        "Sellers require KYC verification before they can receive payouts.",
      ],
      side_effects: [
        "Email change → re-send verification email + sync to CRM (Salesforce) + re-subscribe in email platform.",
        "Role change to 'seller' → trigger KYC onboarding workflow.",
        "Hard delete is NEVER done — only set deleted_at.",
      ],
      known_footguns: [
        "The `users` table has a partial index on email WHERE deleted_at IS NULL. Queries without this filter will be slow at scale.",
        "Do not use user.id as a display identifier — use user.public_id (UUID). The integer id leaks account count.",
        "password_reset_token expires in 1 hour but the column is never nulled out after use — check used_at instead.",
      ],
    },

    Subscription: {
      description: "Recurring billing relationship between a user and a plan.",
      fields: {
        status: {
          type: "enum",
          values: ["trialing", "active", "paused", "past_due", "cancelled", "expired"],
          notes: "Source of truth is Stripe. Our DB is a cache — always verify with Stripe for billing decisions.",
        },
        plan_id: {
          type: "string",
          notes: "References the plans config file, not a DB table. Plans are static config.",
        },
        cancel_at_period_end: {
          type: "boolean",
          notes: "True means user cancelled but still has access until period ends. Do NOT treat as cancelled.",
        },
      },
      rules: [
        "Trial users cannot be paused — they can only be cancelled or converted to paid.",
        "Cancellation takes effect at period end, not immediately (respect cancel_at_period_end).",
        "Reactivation within 7 days of cancellation restores original pricing (check reactivation_eligible_until).",
        "Enterprise plan downgrades require manual approval — raise a task in the billing queue, do not auto-apply.",
        "A user can only have one active subscription at a time.",
      ],
      side_effects: [
        "Any status change triggers a webhook to billing-service AND updates feature flags via LaunchDarkly.",
        "Cancellation emails are sent by the billing-service, NOT by application code — do not send them manually.",
        "Downgrade removes access to premium features immediately, even mid-cycle.",
      ],
      known_footguns: [
        "cancel_at_period_end = true does NOT mean the subscription is cancelled yet. Check status = 'active' AND cancel_at_period_end for 'scheduled cancellation' state.",
        "Stripe subscription IDs start with 'sub_'. Our internal subscription.id is different — never confuse them.",
        "Do not use subscription.updated_at to detect plan changes — Stripe webhooks can arrive out of order.",
      ],
    },

    Invoice: {
      description: "A billing record for a completed payment period.",
      fields: {
        amount_due: {
          type: "number",
          notes: "In cents. May differ from subscription plan price due to coupons/credits.",
        },
        status: {
          type: "enum",
          values: ["draft", "open", "paid", "void", "uncollectible"],
          notes: "Only Stripe should move invoices to 'paid'. Never update this manually.",
        },
      },
      rules: [
        "Invoices are immutable once paid. Create a credit note instead of modifying.",
        "VAT is only applied to EU customers — check user.tax_region.",
        "Invoices must be retained for 10 years (financial compliance).",
      ],
      side_effects: [
        "Paid invoice → unlock feature access + send receipt email via billing-service.",
        "Void invoice → notify finance team via Slack #finance-alerts channel.",
      ],
      known_footguns: [
        "Invoice line items include tax as a separate line — do not sum all lines for the subtotal.",
        "Draft invoices exist in Stripe before they are finalized. Never expose draft invoices to users.",
      ],
    },
  },

  state_machines: {
    "Order.status": {
      initial: "draft",
      transitions: [
        {
          from: "draft",
          to: "pending",
          condition: "Payment method attached and items validated.",
          side_effects: ["Reserve inventory.", "Start payment authorization timeout (30 min)."],
        },
        {
          from: "pending",
          to: "confirmed",
          condition: "Payment successfully captured.",
          side_effects: ["Emit order.confirmed event.", "Trigger ERP sync.", "Send confirmation email."],
        },
        {
          from: "pending",
          to: "cancelled",
          condition: "Payment failed or authorization expired.",
          side_effects: ["Release inventory reservation.", "Notify user."],
        },
        {
          from: "confirmed",
          to: "shipped",
          condition: "Fulfillment system reports shipment.",
          side_effects: ["Send shipping notification with tracking number."],
        },
        {
          from: "shipped",
          to: "delivered",
          condition: "Carrier confirms delivery OR 14 days elapsed.",
          side_effects: ["Trigger post-purchase review request (48hr delay)."],
        },
        {
          from: "confirmed",
          to: "cancelled",
          condition: "Cancelled before fulfillment picks it up.",
          side_effects: ["Trigger refund.", "Release inventory.", "Notify fulfillment system."],
        },
        {
          from: "delivered",
          to: "refunded",
          condition: "Via refund service only. Do not set directly.",
          side_effects: ["Issue Stripe refund.", "Notify warehouse for return label if physical item."],
        },
      ],
    },

    "Subscription.status": {
      initial: "trialing",
      transitions: [
        {
          from: "trialing",
          to: "active",
          condition: "Trial period ends and payment method charged successfully.",
          side_effects: ["Upgrade feature access.", "Send 'welcome to paid' email."],
        },
        {
          from: "trialing",
          to: "cancelled",
          condition: "User cancels during trial OR payment fails at trial end.",
          side_effects: ["Revoke feature access.", "Send cancellation survey."],
        },
        {
          from: "active",
          to: "paused",
          condition: "User requests pause (max 3 months). Not available on trial or enterprise.",
          side_effects: ["Pause Stripe billing.", "Retain feature access for 7 days grace period."],
        },
        {
          from: "paused",
          to: "active",
          condition: "User resumes OR pause period expires.",
          side_effects: ["Resume Stripe billing.", "Restore full feature access immediately."],
        },
        {
          from: "active",
          to: "past_due",
          condition: "Recurring payment fails.",
          side_effects: ["Start Stripe dunning sequence.", "Degrade (not revoke) feature access."],
        },
        {
          from: "past_due",
          to: "active",
          condition: "Payment eventually succeeds during dunning.",
          side_effects: ["Restore full feature access.", "Send payment success notification."],
        },
        {
          from: "past_due",
          to: "cancelled",
          condition: "All dunning retries exhausted (default: 4 attempts over 14 days).",
          side_effects: ["Revoke feature access.", "Send cancellation due to non-payment email."],
        },
      ],
    },
  },

  cross_system_effects: {
    "user.email_changed": {
      description: "Updating a user's email address.",
      affected_systems: [
        { system: "Auth (Supabase)", action: "Update email + trigger re-verification flow." },
        { system: "CRM (Salesforce)", action: "Sync new email via crm-sync-service (async)." },
        { system: "Email Platform (SendGrid)", action: "Update contact email to preserve send history." },
        { system: "Billing (Stripe)", action: "Update Stripe customer email for receipt delivery." },
      ],
      do_not: "Do not update email directly in the DB. Use UserService.changeEmail() which orchestrates all of the above.",
    },

    "order.cancelled": {
      description: "Cancelling an order.",
      affected_systems: [
        { system: "Inventory Service", action: "Release reserved stock (async job)." },
        { system: "Payment (Stripe)", action: "Void authorization or issue refund depending on capture state." },
        { system: "ERP", action: "Send cancellation notice if order was already synced." },
        { system: "Email Platform", action: "Send cancellation confirmation to customer." },
      ],
      do_not: "Do not cancel and refund in the same transaction — they are separate async operations.",
    },

    "subscription.plan_changed": {
      description: "Upgrading or downgrading a subscription plan.",
      affected_systems: [
        { system: "Billing (Stripe)", action: "Update subscription items with proration." },
        { system: "Feature Flags (LaunchDarkly)", action: "Update user's plan segment immediately." },
        { system: "CRM (Salesforce)", action: "Update MRR and plan fields on the account." },
        { system: "Data Warehouse", action: "Event streamed via Segment for analytics." },
      ],
      do_not: "Do not update feature access directly — it flows from the LaunchDarkly segment update.",
    },
  },

  global_footguns: [
    "Never use application-level UUIDs as sort keys — they are not monotonic. Use created_at or a sequence.",
    "All monetary values are stored in cents (integers). Never use floats for money.",
    "Soft deletes are the standard. Always check for a deleted_at or is_deleted field before querying.",
    "Feature flags are in LaunchDarkly. Never gate features with hard-coded env vars in business logic.",
    "Background jobs are idempotent by design. Do not add logic that assumes a job runs exactly once.",
    "The event bus (Kafka) delivers at-least-once. Consumers must be idempotent.",
    "Do not log PII (email, name, phone) in application logs. Use user_id only.",
    "All external API calls must go through the service layer, never directly from controllers.",
    "Timestamps are stored in UTC. Convert only at the display layer.",
  ],
};

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface FieldDef {
  type: string;
  values?: string[];
  notes?: string;
  deprecated?: boolean;
  replacement?: string;
}

interface EntityDef {
  description: string;
  fields: Record<string, FieldDef>;
  rules: string[];
  side_effects: string[];
  known_footguns: string[];
}

interface Transition {
  from: string;
  to: string;
  condition: string;
  side_effects: string[];
}

interface StateMachine {
  initial: string;
  transitions: Transition[];
}

interface AffectedSystem {
  system: string;
  action: string;
}

interface CrossSystemEffect {
  description: string;
  affected_systems: AffectedSystem[];
  do_not: string;
}

interface BusinessLogicStore {
  meta: {
    project: string;
    version: string;
    last_updated: string;
    owner: string;
  };
  entities: Record<string, EntityDef>;
  state_machines: Record<string, StateMachine>;
  cross_system_effects: Record<string, CrossSystemEffect>;
  global_footguns: string[];
}

// =============================================================================
// MCP SERVER
// =============================================================================

const server = new Server({
  name: "business-logic-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// --- List Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_entity_rules",
      description:
        "Returns all business rules, field definitions, constraints, side effects, and known footguns for a domain entity (e.g. Order, User, Subscription). Call this before writing any code that creates, reads, updates, or deletes an entity.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "The entity name, e.g. 'Order', 'User', 'Subscription'.",
          },
        },
        required: ["entity"],
      },
    },
    {
      name: "get_state_transitions",
      description:
        "Returns valid state transitions for an entity's status field, including conditions and side effects for each transition. Call this before writing any code that changes an entity's status.",
      inputSchema: {
        type: "object",
        properties: {
          entity_field: {
            type: "string",
            description: "The entity + field in dot notation, e.g. 'Order.status', 'Subscription.status'.",
          },
          current_state: {
            type: "string",
            description: "Optional. Filter transitions to only those starting from this state.",
          },
        },
        required: ["entity_field"],
      },
    },
    {
      name: "get_field_context",
      description:
        "Returns the semantics, caveats, deprecation status, and gotchas for a specific field on an entity. Call this when you're unsure how to use or interpret a field.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "The entity name, e.g. 'Order'." },
          field: { type: "string", description: "The field name, e.g. 'total_amount'." },
        },
        required: ["entity", "field"],
      },
    },
    {
      name: "get_cross_system_effects",
      description:
        "Returns all downstream systems affected by a given operation and what happens in each. Call this before implementing any operation that might have cross-service implications.",
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description: "The operation key, e.g. 'user.email_changed', 'order.cancelled'. Call list_operations to see all available keys.",
          },
        },
        required: ["operation"],
      },
    },
    {
      name: "list_operations",
      description: "Lists all cross-system operations that have documented effects. Use this to discover what operations are tracked.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_footguns",
      description:
        "Returns a list of known 'gotchas' and common mistakes — things that have caused bugs before. Optionally scoped to an entity, or returns global footguns if no entity is provided.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "Optional entity name to scope results. Omit for global footguns.",
          },
        },
      },
    },
    {
      name: "list_entities",
      description: "Lists all entities in the business logic store with a brief description of each.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// --- Handle Tool Calls ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  switch (name) {
    // -------------------------------------------------------------------------
    case "list_entities": {
      const result = Object.entries(BUSINESS_LOGIC.entities).map(([entity, def]) => ({
        entity,
        description: def.description,
        fields: Object.keys(def.fields),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_entity_rules": {
      const entity = args.entity as string | undefined;
      if (!entity) {
        return { content: [{ type: "text", text: "Missing required argument: 'entity'." }], isError: true };
      }
      const def = BUSINESS_LOGIC.entities[entity];
      if (!def) {
        const available = Object.keys(BUSINESS_LOGIC.entities).join(", ");
        return {
          content: [{ type: "text", text: `Entity '${entity}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ entity, ...def }, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_state_transitions": {
      const entity_field = args.entity_field as string | undefined;
      if (!entity_field) {
        return { content: [{ type: "text", text: "Missing required argument: 'entity_field'." }], isError: true };
      }
      const current_state = args.current_state as string | undefined;
      const sm = BUSINESS_LOGIC.state_machines[entity_field];
      if (!sm) {
        const available = Object.keys(BUSINESS_LOGIC.state_machines).join(", ");
        return {
          content: [{ type: "text", text: `State machine '${entity_field}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      const transitions = current_state
        ? sm.transitions.filter((t) => t.from === current_state)
        : sm.transitions;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ entity_field, initial_state: sm.initial, transitions }, null, 2),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    case "get_field_context": {
      const entity = args.entity as string | undefined;
      const field = args.field as string | undefined;
      if (!entity || !field) {
        return { content: [{ type: "text", text: "Missing required arguments: 'entity' and 'field'." }], isError: true };
      }
      const def = BUSINESS_LOGIC.entities[entity];
      if (!def) {
        return { content: [{ type: "text", text: `Entity '${entity}' not found.` }], isError: true };
      }
      const fieldDef = def.fields[field];
      if (!fieldDef) {
        const available = Object.keys(def.fields).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Field '${field}' not found on '${entity}'. Available fields: ${available}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ entity, field, ...fieldDef }, null, 2) }],
      };
    }

    // -------------------------------------------------------------------------
    case "list_operations": {
      const ops = Object.entries(BUSINESS_LOGIC.cross_system_effects).map(([key, val]) => ({
        operation: key,
        description: val.description,
      }));
      return { content: [{ type: "text", text: JSON.stringify(ops, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_cross_system_effects": {
      const operation = args.operation as string | undefined;
      if (!operation) {
        return { content: [{ type: "text", text: "Missing required argument: 'operation'." }], isError: true };
      }
      const effect = BUSINESS_LOGIC.cross_system_effects[operation];
      if (!effect) {
        const available = Object.keys(BUSINESS_LOGIC.cross_system_effects).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Operation '${operation}' not found. Available: ${available}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ operation, ...effect }, null, 2) }],
      };
    }

    // -------------------------------------------------------------------------
    case "get_footguns": {
      const entity = args.entity as string | undefined;
      if (entity) {
        const def = BUSINESS_LOGIC.entities[entity];
        if (!def) {
          return { content: [{ type: "text", text: `Entity '${entity}' not found.` }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  entity,
                  entity_footguns: def.known_footguns,
                  global_footguns: BUSINESS_LOGIC.global_footguns,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ global_footguns: BUSINESS_LOGIC.global_footguns }, null, 2),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Business Logic MCP running — project: ${BUSINESS_LOGIC.meta.project} v${BUSINESS_LOGIC.meta.version}`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
