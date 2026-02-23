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
// FEATURE 1: DYNAMIC TOOL REGISTRY (Microflows / Business Functions)
// Satisfies: Dynamic Tool Exposure — automatically expose business functions as
// discoverable MCP tools without custom code.
// =============================================================================

const MICROFLOWS: Record<string, MicroflowDef> = {
  CalculateShippingCost: {
    name: "CalculateShippingCost",
    description:
      "Calculates shipping cost for an order based on weight, destination, and seller type. Applies flash-sale and marketplace-seller threshold rules automatically.",
    inputs: [
      { name: "order_id", type: "string", required: true, description: "The order to calculate shipping for." },
      { name: "destination_zip", type: "string", required: true, description: "Destination zip/postal code." },
      { name: "weight_grams", type: "number", required: true, description: "Total shipment weight in grams." },
    ],
    outputs: [
      { name: "shipping_cost_cents", type: "number", description: "Calculated shipping cost in cents." },
      { name: "carrier", type: "string", description: "Recommended carrier (UPS, USPS, FedEx)." },
      { name: "estimated_days", type: "number", description: "Estimated delivery days." },
    ],
    steps: [
      "1. Fetch order to determine marketplace_seller_id (affects threshold rules).",
      "2. Apply flash_sale_active feature flag to check if reduced threshold is active.",
      "3. Calculate distance zone from destination zip.",
      "4. Look up carrier rates in the shipping rate table.",
      "5. Apply any active shipping promotions.",
      "6. Return lowest qualifying rate.",
    ],
    tags: ["shipping", "order", "pricing"],
    owner: "fulfillment-team",
    async: false,
  },
  ValidateOrderItems: {
    name: "ValidateOrderItems",
    description:
      "Validates that all items in an order are available, correctly priced, and comply with mixed-item rules (no digital+physical in the same order).",
    inputs: [
      { name: "order_id", type: "string", required: true, description: "Order to validate." },
    ],
    outputs: [
      { name: "valid", type: "boolean", description: "Whether the order passed all validations." },
      { name: "violations", type: "string[]", description: "List of validation failures if any." },
    ],
    steps: [
      "1. Fetch all items from order.",
      "2. Check inventory availability for each item.",
      "3. Verify no mix of digital and physical items.",
      "4. Confirm current prices match order line prices (within allowed drift).",
      "5. Check for any region restrictions on items.",
    ],
    tags: ["order", "validation"],
    owner: "order-team",
    async: false,
  },
  ProcessRefund: {
    name: "ProcessRefund",
    description:
      "Orchestrates a full or partial refund for a delivered order through the refund service. Emits events and triggers warehouse return-label job for physical items.",
    inputs: [
      { name: "order_id", type: "string", required: true, description: "The order to refund." },
      { name: "reason", type: "string", required: true, description: "Refund reason code." },
      { name: "amount_cents", type: "number", required: false, description: "Partial refund amount in cents. Omit for full refund." },
    ],
    outputs: [
      { name: "refund_id", type: "string", description: "Stripe refund ID." },
      { name: "status", type: "string", description: "'succeeded' | 'pending' | 'failed'." },
    ],
    steps: [
      "1. Verify order status is 'delivered' (cannot refund earlier statuses).",
      "2. Call Stripe to issue refund via payment_intent_id.",
      "3. Update order status to 'refunded' via order service (not directly).",
      "4. Trigger warehouse return-label job if physical items exist.",
      "5. Emit refund.processed event to event bus.",
    ],
    tags: ["order", "billing", "refund"],
    owner: "billing-team",
    async: true,
  },
  SyncUserToCRM: {
    name: "SyncUserToCRM",
    description:
      "Synchronizes a user's profile data to Salesforce CRM. Must be called via UserService.changeEmail(), never directly.",
    inputs: [
      { name: "user_id", type: "string", required: true, description: "Internal user ID." },
      { name: "changed_fields", type: "string[]", required: true, description: "List of fields that changed." },
    ],
    outputs: [
      { name: "crm_contact_id", type: "string", description: "Salesforce contact ID." },
      { name: "synced_at", type: "timestamp", description: "ISO timestamp of sync." },
    ],
    steps: [
      "1. Fetch current user profile.",
      "2. Map user fields to Salesforce contact schema.",
      "3. Upsert Salesforce contact via crm-sync-service.",
      "4. Store crm_contact_id on user record.",
      "5. Emit crm.user_synced event.",
    ],
    tags: ["user", "crm", "sync"],
    owner: "platform-team",
    async: true,
  },
};

// =============================================================================
// FEATURE 2: ENTERPRISE RULES ENGINE (Decision Tables / DMN)
// Satisfies: Enterprise-Grade Rules Engine — decision tables with hit policies.
// =============================================================================

const DECISION_TABLES: Record<string, DecisionTable> = {
  shipping_threshold: {
    id: "shipping_threshold",
    description: "Determines free-shipping threshold based on seller type and active promotions.",
    hitPolicy: "FIRST",
    inputs: [
      { name: "is_marketplace_seller", type: "boolean", description: "True if fulfilled by marketplace seller." },
      { name: "flash_sale_active", type: "boolean", description: "Whether the flash_sale_active feature flag is on." },
    ],
    outputs: [
      { name: "free_shipping_threshold_cents", type: "number", description: "Free shipping threshold in cents." },
    ],
    rows: [
      {
        id: "R1",
        conditions: { flash_sale_active: true },
        outputs: { free_shipping_threshold_cents: 2000 },
        priority: 10,
        annotation: "Flash sale overrides all other rules ($20 threshold).",
      },
      {
        id: "R2",
        conditions: { is_marketplace_seller: true, flash_sale_active: false },
        outputs: { free_shipping_threshold_cents: 7500 },
        priority: 5,
        annotation: "Marketplace sellers have higher threshold ($75).",
      },
      {
        id: "R3",
        conditions: { is_marketplace_seller: false, flash_sale_active: false },
        outputs: { free_shipping_threshold_cents: 5000 },
        priority: 1,
        annotation: "Standard first-party threshold ($50).",
      },
    ],
  },
  discount_eligibility: {
    id: "discount_eligibility",
    description: "Evaluates discount eligibility based on customer role, order amount, and order history.",
    hitPolicy: "COLLECT",
    inputs: [
      { name: "user_role", type: "string", description: "User role: consumer | seller | support | admin." },
      { name: "order_amount_cents", type: "number", description: "Total order amount in cents." },
      { name: "is_first_order", type: "boolean", description: "Whether this is the user's first order." },
    ],
    outputs: [
      { name: "discount_type", type: "string", description: "Type of discount applied." },
      { name: "discount_percent", type: "number", description: "Discount percentage (0–100)." },
    ],
    rows: [
      {
        id: "R1",
        conditions: { is_first_order: true },
        outputs: { discount_type: "FIRST_ORDER", discount_percent: 10 },
        annotation: "All first-time customers get 10% off.",
      },
      {
        id: "R2",
        conditions: { order_amount_cents: { op: ">=", value: 10000 } },
        outputs: { discount_type: "BULK_ORDER", discount_percent: 5 },
        annotation: "Orders over $100 get 5% bulk discount.",
      },
      {
        id: "R3",
        conditions: { user_role: "seller" },
        outputs: { discount_type: "SELLER_DISCOUNT", discount_percent: 8 },
        annotation: "Sellers get 8% discount on their own purchases.",
      },
    ],
  },
  subscription_downgrade_approval: {
    id: "subscription_downgrade_approval",
    description: "Determines whether a subscription plan change requires manual approval.",
    hitPolicy: "UNIQUE",
    inputs: [
      { name: "current_plan", type: "string", description: "Current plan ID." },
      { name: "target_plan", type: "string", description: "Target plan ID." },
      { name: "is_enterprise", type: "boolean", description: "Whether the subscription is on an enterprise plan." },
    ],
    outputs: [
      { name: "requires_approval", type: "boolean", description: "Whether manual approval is required." },
      { name: "approval_queue", type: "string", description: "Queue to raise the approval task in." },
      { name: "reason", type: "string", description: "Reason for the decision." },
    ],
    rows: [
      {
        id: "R1",
        conditions: { is_enterprise: true },
        outputs: { requires_approval: true, approval_queue: "billing-approvals", reason: "Enterprise downgrades always require manual approval." },
        annotation: "Per business rule: Enterprise plan downgrades must go through billing queue.",
      },
      {
        id: "R2",
        conditions: { is_enterprise: false },
        outputs: { requires_approval: false, approval_queue: "", reason: "Non-enterprise plan changes are auto-applied." },
        annotation: "Standard plans can be changed without approval.",
      },
    ],
  },
};

// =============================================================================
// FEATURE 3: STATE MANAGEMENT & UI AUTOMATION
// Satisfies: Enable agents to navigate multi-step forms, open menus, and manage
// UI state to execute logic like a human user.
// =============================================================================

const UI_WORKFLOWS: Record<string, UIWorkflow> = {
  checkout_flow: {
    id: "checkout_flow",
    description: "Multi-step checkout: cart review → shipping info → payment → order confirmed.",
    initial: "cart_review",
    terminal_steps: ["order_confirmed", "order_cancelled"],
    steps: {
      cart_review: {
        id: "cart_review",
        label: "Review Cart",
        description: "User reviews items and quantities before proceeding.",
        fields: [],
        actions: [
          { label: "Proceed to Shipping", next: "shipping_info", condition: "cart.items.length > 0", validation_rules: [] },
          { label: "Cancel", next: "order_cancelled", condition: undefined, validation_rules: [] },
        ],
      },
      shipping_info: {
        id: "shipping_info",
        label: "Shipping Information",
        description: "Collect shipping address and delivery method.",
        fields: [
          { name: "shipping_address", type: "address", required: true, label: "Shipping Address" },
          { name: "shipping_method", type: "select", required: true, label: "Shipping Method" },
        ],
        actions: [
          {
            label: "Continue to Payment",
            next: "payment",
            condition: undefined,
            validation_rules: ["shipping_address must be a valid postal address", "shipping_method must be selected"],
          },
          { label: "Back to Cart", next: "cart_review", condition: undefined, validation_rules: [] },
        ],
      },
      payment: {
        id: "payment",
        label: "Payment",
        description: "Collect and authorize payment method.",
        fields: [
          { name: "payment_method", type: "stripe_element", required: true, label: "Payment Method" },
          { name: "billing_same_as_shipping", type: "boolean", required: false, label: "Billing address same as shipping" },
          { name: "billing_address", type: "address", required: false, label: "Billing Address (if different)" },
        ],
        actions: [
          {
            label: "Place Order",
            next: "order_confirmed",
            condition: undefined,
            validation_rules: [
              "payment_method must be valid",
              "billing_address required if billing_same_as_shipping is false",
            ],
          },
          { label: "Back to Shipping", next: "shipping_info", condition: undefined, validation_rules: [] },
        ],
      },
      order_confirmed: {
        id: "order_confirmed",
        label: "Order Confirmed",
        description: "Order placed successfully. Confirmation email sent.",
        fields: [],
        actions: [],
      },
      order_cancelled: {
        id: "order_cancelled",
        label: "Order Cancelled",
        description: "Order was cancelled before placement.",
        fields: [],
        actions: [],
      },
    },
  },
  refund_flow: {
    id: "refund_flow",
    description: "Agent-driven refund flow: reason selection → amount confirmation → processing.",
    initial: "reason_selection",
    terminal_steps: ["refund_complete", "refund_rejected"],
    steps: {
      reason_selection: {
        id: "reason_selection",
        label: "Select Refund Reason",
        description: "Agent or user selects the refund reason code.",
        fields: [
          { name: "reason_code", type: "select", required: true, label: "Reason" },
          { name: "reason_details", type: "text", required: false, label: "Additional Details" },
        ],
        actions: [
          { label: "Continue", next: "amount_confirmation", condition: "reason_code is set", validation_rules: ["reason_code must be selected"] },
          { label: "Cancel", next: "refund_rejected", condition: undefined, validation_rules: [] },
        ],
      },
      amount_confirmation: {
        id: "amount_confirmation",
        label: "Confirm Refund Amount",
        description: "Confirm whether this is a full or partial refund.",
        fields: [
          { name: "refund_type", type: "select", required: true, label: "Full or Partial" },
          { name: "partial_amount_cents", type: "number", required: false, label: "Partial Amount (cents)" },
        ],
        actions: [
          {
            label: "Submit Refund",
            next: "refund_complete",
            condition: undefined,
            validation_rules: ["partial_amount_cents required if refund_type = 'partial'"],
          },
          { label: "Back", next: "reason_selection", condition: undefined, validation_rules: [] },
        ],
      },
      refund_complete: {
        id: "refund_complete",
        label: "Refund Processed",
        description: "Refund submitted successfully. Stripe refund ID returned.",
        fields: [],
        actions: [],
      },
      refund_rejected: {
        id: "refund_rejected",
        label: "Refund Rejected",
        description: "Refund request was cancelled or rejected.",
        fields: [],
        actions: [],
      },
    },
  },
};

// =============================================================================
// FEATURE 5: GOVERNANCE & SECURITY (Permissions + Audit Trail)
// Satisfies: Enforce permissions and audit trails, ensuring agents act strictly
// within authenticated user roles.
// =============================================================================

const PERMISSIONS: Record<string, Record<string, PermissionDef>> = {
  consumer: {
    Order: {
      entity: "Order",
      allowed_actions: ["read_own", "create", "cancel_pending"],
      conditions: "Can only access orders where user_id = current_user.id",
      denied_actions: ["read_others", "modify_after_confirmed", "delete"],
    },
    Subscription: {
      entity: "Subscription",
      allowed_actions: ["read_own", "cancel", "pause", "resume"],
      conditions: "Can only access own subscriptions",
      denied_actions: ["read_others", "force_status_change", "delete"],
    },
    Invoice: {
      entity: "Invoice",
      allowed_actions: ["read_own"],
      conditions: "Can only access own invoices",
      denied_actions: ["modify", "void", "delete"],
    },
    User: {
      entity: "User",
      allowed_actions: ["read_own_profile", "update_own_email", "update_own_password"],
      conditions: "Can only access own user record",
      denied_actions: ["read_others", "change_role", "delete_others"],
    },
  },
  support: {
    Order: {
      entity: "Order",
      allowed_actions: ["read_any"],
      conditions: "Read-only access to all orders for support purposes",
      denied_actions: ["create", "modify", "cancel", "delete"],
    },
    User: {
      entity: "User",
      allowed_actions: ["read_any"],
      conditions: "Read-only access to user profiles",
      denied_actions: ["update", "delete", "change_role"],
    },
    Subscription: {
      entity: "Subscription",
      allowed_actions: ["read_any"],
      conditions: "Read-only subscription access",
      denied_actions: ["modify", "cancel", "delete"],
    },
    Invoice: {
      entity: "Invoice",
      allowed_actions: ["read_any"],
      conditions: "Read-only invoice access",
      denied_actions: ["modify", "void", "delete"],
    },
  },
  seller: {
    Order: {
      entity: "Order",
      allowed_actions: ["read_marketplace_own", "update_shipping_status"],
      conditions: "Can only access orders where marketplace_seller_id = current_user.seller_id",
      denied_actions: ["read_first_party_orders", "cancel", "delete"],
    },
    User: {
      entity: "User",
      allowed_actions: ["read_own_profile", "update_own_profile"],
      conditions: "Can only access own seller profile",
      denied_actions: ["read_others"],
    },
  },
  admin: {
    Order: {
      entity: "Order",
      allowed_actions: ["read_any", "create", "modify", "cancel", "refund"],
      conditions: "Full access to all orders",
      denied_actions: [],
    },
    User: {
      entity: "User",
      allowed_actions: ["read_any", "create", "update", "soft_delete", "change_role"],
      conditions: "Cannot delete other admins — only superadmin can",
      denied_actions: ["hard_delete", "delete_admin"],
    },
    Subscription: {
      entity: "Subscription",
      allowed_actions: ["read_any", "modify", "cancel", "grant_extension"],
      conditions: "Full subscription management",
      denied_actions: [],
    },
    Invoice: {
      entity: "Invoice",
      allowed_actions: ["read_any", "void"],
      conditions: "Can view and void invoices; cannot modify paid invoices",
      denied_actions: ["modify_paid", "delete"],
    },
  },
};

const AUDIT_LOG: AuditLogEntry[] = [];

// =============================================================================
// FEATURE 6: MULTI-SCENARIO LOGIC REUSE (Rulesets / Subflows)
// Satisfies: Package logic into reusable components that can be nested and
// triggered across different apps.
// =============================================================================

const RULESETS: Record<string, Ruleset> = {
  order_validation: {
    id: "order_validation",
    description: "Core order validation rules — reused across checkout, admin order creation, and the order API.",
    version: "2.1.0",
    rules: [
      { id: "OV1", condition: "items.length > 0", action: "PASS: Order has at least one item.", priority: 100 },
      { id: "OV2", condition: "all items have valid sku", action: "PASS: All SKUs are valid.", priority: 90 },
      {
        id: "OV3",
        condition: "NOT (has_digital_items AND has_physical_items)",
        action: "FAIL: Cannot mix digital and physical items in one order.",
        priority: 80,
      },
      { id: "OV4", condition: "total_amount > 0", action: "FAIL: Order total must be greater than zero.", priority: 70 },
      { id: "OV5", condition: "user.deleted_at IS NULL", action: "FAIL: Cannot place orders for deleted users.", priority: 60 },
    ],
    reuse_in: ["checkout_service", "admin_panel", "order_api", "bulk_import"],
    tags: ["order", "validation", "core"],
  },
  payment_eligibility: {
    id: "payment_eligibility",
    description: "Rules determining whether a user can be charged for a subscription or order.",
    version: "1.3.0",
    rules: [
      { id: "PE1", condition: "user.stripe_customer_id IS NOT NULL", action: "PASS: Stripe customer exists.", priority: 100 },
      {
        id: "PE2",
        condition: "subscription.status NOT IN ('cancelled', 'expired')",
        action: "PASS: Subscription is in a chargeable state.",
        priority: 90,
      },
      { id: "PE3", condition: "invoice.amount_due > 0", action: "PASS: Invoice has a positive balance.", priority: 80 },
      { id: "PE4", condition: "user.deleted_at IS NULL", action: "FAIL: Cannot charge deleted users.", priority: 70 },
    ],
    reuse_in: ["billing_service", "subscription_renewal_job", "upgrade_flow"],
    tags: ["billing", "payment", "subscription"],
  },
  seller_kyc: {
    id: "seller_kyc",
    description: "KYC verification rules for marketplace sellers before they can receive payouts.",
    version: "1.0.2",
    rules: [
      { id: "SK1", condition: "kyc.identity_verified = true", action: "PASS: Identity verified.", priority: 100 },
      { id: "SK2", condition: "kyc.bank_account_verified = true", action: "PASS: Bank account verified.", priority: 90 },
      { id: "SK3", condition: "kyc.tax_id_provided = true", action: "PASS: Tax ID on file.", priority: 80 },
      { id: "SK4", condition: "kyc.terms_accepted = true", action: "PASS: Seller terms accepted.", priority: 70 },
    ],
    reuse_in: ["seller_onboarding", "payout_service", "marketplace_service"],
    tags: ["seller", "kyc", "compliance"],
  },
  data_retention: {
    id: "data_retention",
    description: "Data retention compliance rules shared across GDPR deletion requests and audit tooling.",
    version: "1.0.0",
    rules: [
      { id: "DR1", condition: "user data age < 7 years", action: "RETAIN: User order/data records are within retention window.", priority: 100 },
      { id: "DR2", condition: "invoice age < 10 years", action: "RETAIN: Invoice records are within financial compliance window.", priority: 90 },
      { id: "DR3", condition: "user.deleted_at IS NOT NULL AND user data age >= 7 years", action: "ELIGIBLE_FOR_PURGE: User data outside retention window.", priority: 80 },
    ],
    reuse_in: ["gdpr_deletion_service", "data_audit_tool", "compliance_reports"],
    tags: ["compliance", "gdpr", "retention"],
  },
};

// =============================================================================
// FEATURE 7: PRODUCTION DEBUGGING (Execution Log + Shadow Testing)
// Satisfies: Shadow testing for side-by-side evaluation, detailed logging, and
// real-time monitoring of logic execution.
// =============================================================================

const EXECUTION_LOG: ExecutionLogEntry[] = [];
const SHADOW_TESTS: Record<string, ShadowTest> = {};
let executionCounter = 0;
const SERVER_START_TIME = Date.now();

function logExecution(
  tool: string,
  inputs: Record<string, unknown>,
  outputSummary: string,
  durationMs: number,
  shadow = false
): string {
  const id = `exec_${++executionCounter}`;
  EXECUTION_LOG.push({
    id,
    timestamp: new Date().toISOString(),
    tool,
    inputs,
    output_summary: outputSummary,
    duration_ms: durationMs,
    shadow,
  });
  // Keep log bounded to last 500 entries
  if (EXECUTION_LOG.length > 500) EXECUTION_LOG.shift();
  return id;
}

/** Shared helper: test whether a set of row conditions matches the provided inputs. */
function rowMatchesInputs(
  conditions: DecisionTableRow["conditions"],
  inputs: Record<string, unknown>
): boolean {
  for (const [condField, condValue] of Object.entries(conditions)) {
    const inputVal = inputs[condField];
    if (condValue !== null && typeof condValue === "object" && "op" in condValue) {
      const { op, value } = condValue as DecisionTableConditionValue;
      if (op === ">=" && !(Number(inputVal) >= Number(value))) return false;
      if (op === "<=" && !(Number(inputVal) <= Number(value))) return false;
      if (op === ">" && !(Number(inputVal) > Number(value))) return false;
      if (op === "<" && !(Number(inputVal) < Number(value))) return false;
      if (op === "!=" && !(inputVal !== value)) return false;
    } else if (inputVal !== condValue) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// FEATURE 9: HYBRID AUTHORING — RULE TEMPLATES
// Satisfies: No-code visual builders for business experts AND extensible APIs
// for developers.
// =============================================================================

const RULE_TEMPLATES: Record<string, RuleTemplate> = {
  threshold_guard: {
    id: "threshold_guard",
    name: "Threshold Guard",
    category: "Validation",
    description: "Generate a rule that fails when a numeric field exceeds or falls below a threshold.",
    parameters: [
      { name: "field", type: "string", description: "Field path to check (e.g. order.total_amount)", example: "order.total_amount" },
      { name: "operator", type: "string", description: "Comparison operator: >, <, >=, <=", example: ">=" },
      { name: "threshold", type: "number", description: "Numeric threshold value", example: "10000" },
      { name: "message", type: "string", description: "Error message when rule fails", example: "Order total exceeds maximum allowed amount." },
    ],
    template_rule: "if {field} {operator} {threshold} then FAIL: {message}",
    example_output: "if order.total_amount >= 10000 then FAIL: Order total exceeds maximum allowed amount.",
  },
  status_transition_guard: {
    id: "status_transition_guard",
    name: "Status Transition Guard",
    category: "State Machine",
    description: "Generate a rule that prevents invalid status transitions.",
    parameters: [
      { name: "entity", type: "string", description: "Entity name (e.g. Order)", example: "Order" },
      { name: "from_status", type: "string", description: "Current status value", example: "shipped" },
      { name: "to_status", type: "string", description: "Target status value that should be blocked", example: "cancelled" },
    ],
    template_rule: "if {entity}.status = '{from_status}' then DENY transition to '{to_status}'",
    example_output: "if Order.status = 'shipped' then DENY transition to 'cancelled'",
  },
  role_permission_guard: {
    id: "role_permission_guard",
    name: "Role Permission Guard",
    category: "Governance",
    description: "Generate a rule that restricts an action to specific roles.",
    parameters: [
      { name: "action", type: "string", description: "Action to restrict (e.g. cancel_order)", example: "cancel_order" },
      { name: "allowed_roles", type: "string", description: "Comma-separated list of allowed roles", example: "admin,support" },
      { name: "entity", type: "string", description: "Entity the action applies to", example: "Order" },
    ],
    template_rule: "if current_user.role NOT IN [{allowed_roles}] then DENY '{action}' on {entity}",
    example_output: "if current_user.role NOT IN [admin, support] then DENY 'cancel_order' on Order",
  },
  null_safety_guard: {
    id: "null_safety_guard",
    name: "Null Safety Guard",
    category: "Validation",
    description: "Generate a rule that ensures a required field is never null at a given point in a flow.",
    parameters: [
      { name: "entity", type: "string", description: "Entity name", example: "User" },
      { name: "field", type: "string", description: "Field that must not be null", example: "stripe_customer_id" },
      { name: "context", type: "string", description: "When this check applies", example: "before processing payment" },
    ],
    template_rule: "if {entity}.{field} IS NULL then FAIL: {entity}.{field} must be set {context}",
    example_output: "if User.stripe_customer_id IS NULL then FAIL: User.stripe_customer_id must be set before processing payment",
  },
  soft_delete_filter: {
    id: "soft_delete_filter",
    name: "Soft Delete Filter",
    category: "Query Safety",
    description: "Generate a reminder rule to always filter soft-deleted records in queries.",
    parameters: [
      { name: "entity", type: "string", description: "Entity name", example: "User" },
      { name: "delete_field", type: "string", description: "Soft-delete column name", example: "deleted_at" },
    ],
    template_rule: "Always add: WHERE {delete_field} IS NULL to all queries against {entity}",
    example_output: "Always add: WHERE deleted_at IS NULL to all queries against User",
  },
  monetary_cents_guard: {
    id: "monetary_cents_guard",
    name: "Monetary Cents Guard",
    category: "Data Integrity",
    description: "Generate a rule that enforces money fields are stored as integers (cents), never floats.",
    parameters: [
      { name: "entity", type: "string", description: "Entity name", example: "Order" },
      { name: "field", type: "string", description: "Monetary field name", example: "total_amount" },
    ],
    template_rule: "if typeof {entity}.{field} !== 'integer' then FAIL: {entity}.{field} must be stored in cents as an integer, never a float",
    example_output: "if typeof Order.total_amount !== 'integer' then FAIL: Order.total_amount must be stored in cents as an integer, never a float",
  },
};

// =============================================================================
// FEATURE 10: SEMANTIC INTEROPERABILITY
// Satisfies: Unified context model that preserves business meaning across
// operational (transactions) and analytical (KPIs) data.
// =============================================================================

const SEMANTIC_MAPPINGS: SemanticMapping[] = [
  {
    operational_term: "Order.total_amount",
    analytical_term: "gross_revenue_cents",
    description: "The order total in the operational DB maps to gross revenue in analytics pipelines.",
    entity: "Order",
    field: "total_amount",
    transformation: "SUM(order.total_amount) WHERE order.status IN ('confirmed','shipped','delivered','refunded')",
    examples: ["SELECT SUM(total_amount) AS gross_revenue FROM orders WHERE status != 'cancelled'"],
  },
  {
    operational_term: "Order.status = 'delivered'",
    analytical_term: "conversion_event",
    description: "An order reaching 'delivered' is the conversion event for funnel and cohort analysis.",
    entity: "Order",
    field: "status",
    transformation: "COUNT(*) WHERE status = 'delivered' / COUNT(*) WHERE status != 'cancelled'",
    examples: ["SELECT COUNT(*) FROM orders WHERE status = 'delivered' AND created_at BETWEEN :start AND :end"],
  },
  {
    operational_term: "Subscription.status = 'active' AND cancel_at_period_end = false",
    analytical_term: "MRR_contributing",
    description: "Only active subscriptions without scheduled cancellation contribute to Monthly Recurring Revenue. cancel_at_period_end = true means the user has cancelled but revenue is still recognized until period end.",
    entity: "Subscription",
    field: "status",
    transformation: "SUM(plan.price_cents) WHERE subscription.status = 'active' AND cancel_at_period_end = false",
    examples: [
      "SELECT SUM(p.price_cents) FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.status = 'active' AND s.cancel_at_period_end = false",
    ],
  },
  {
    operational_term: "User.deleted_at IS NOT NULL",
    analytical_term: "churned_user",
    description: "A soft-deleted user in the operational DB is a churned user in analytical models.",
    entity: "User",
    field: "deleted_at",
    transformation: "COUNT(*) WHERE deleted_at IS NOT NULL AND deleted_at BETWEEN :start AND :end",
    examples: ["Churn rate = users with deleted_at in period / active users at start of period"],
  },
  {
    operational_term: "Subscription.status transitions to 'cancelled'",
    analytical_term: "subscription_churn_event",
    description: "A subscription cancellation maps to the churn event in retention KPI models and cohort analysis.",
    entity: "Subscription",
    field: "status",
    transformation: "COUNT(*) WHERE status = 'cancelled' AND updated_at BETWEEN :start AND :end",
    examples: ["Cohort churn = subscriptions cancelled / subscriptions active at cohort start"],
  },
  {
    operational_term: "Invoice.status = 'paid'",
    analytical_term: "realized_revenue",
    description: "Only paid invoices count as realized revenue (not recognized or deferred).",
    entity: "Invoice",
    field: "status",
    transformation: "SUM(amount_due) WHERE status = 'paid'",
    examples: ["SELECT SUM(amount_due) FROM invoices WHERE status = 'paid' AND created_at BETWEEN :start AND :end"],
  },
  {
    operational_term: "Order.marketplace_seller_id IS NOT NULL",
    analytical_term: "marketplace_gmv",
    description: "Orders with a marketplace_seller_id contribute to Gross Merchandise Value (GMV) for the marketplace segment.",
    entity: "Order",
    field: "marketplace_seller_id",
    transformation: "SUM(total_amount) WHERE marketplace_seller_id IS NOT NULL AND status IN ('confirmed','shipped','delivered')",
    examples: ["SELECT SUM(total_amount) FROM orders WHERE marketplace_seller_id IS NOT NULL AND status = 'delivered'"],
  },
];

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

// --- Feature 1: Dynamic Tool Registry ---
interface MicroflowInput {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface MicroflowOutput {
  name: string;
  type: string;
  description: string;
}

interface MicroflowDef {
  name: string;
  description: string;
  inputs: MicroflowInput[];
  outputs: MicroflowOutput[];
  steps: string[];
  tags: string[];
  owner?: string;
  async: boolean;
}

// --- Feature 2: Decision Tables (DMN) ---
interface DecisionTableConditionValue {
  op: string;
  value: unknown;
}

interface DecisionTableRow {
  id: string;
  conditions: Record<string, string | number | boolean | null | DecisionTableConditionValue>;
  outputs: Record<string, unknown>;
  priority?: number;
  annotation?: string;
}

interface DecisionTable {
  id: string;
  description: string;
  hitPolicy: "UNIQUE" | "FIRST" | "COLLECT" | "RULE_ORDER";
  inputs: { name: string; type: string; description: string }[];
  outputs: { name: string; type: string; description: string }[];
  rows: DecisionTableRow[];
}

// --- Feature 3: UI Workflows ---
interface UIAction {
  label: string;
  next: string;
  condition?: string;
  validation_rules: string[];
}

interface UIField {
  name: string;
  type: string;
  required: boolean;
  label: string;
}

interface UIStep {
  id: string;
  label: string;
  description: string;
  fields: UIField[];
  actions: UIAction[];
}

interface UIWorkflow {
  id: string;
  description: string;
  initial: string;
  terminal_steps: string[];
  steps: Record<string, UIStep>;
}

// --- Feature 5: Governance & Security ---
interface PermissionDef {
  entity: string;
  allowed_actions: string[];
  conditions?: string;
  denied_actions: string[];
}

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor_id: string;
  role: string;
  action: string;
  entity: string;
  entity_id: string;
  details: string;
}

// --- Feature 6: Logic Reuse (Rulesets) ---
interface RulesetRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
}

interface Ruleset {
  id: string;
  description: string;
  version: string;
  rules: RulesetRule[];
  reuse_in: string[];
  tags: string[];
}

// --- Feature 7: Production Debugging ---
interface ExecutionLogEntry {
  id: string;
  timestamp: string;
  tool: string;
  inputs: Record<string, unknown>;
  output_summary: string;
  duration_ms: number;
  shadow: boolean;
}

interface ShadowTest {
  id: string;
  description: string;
  baseline_tool: string;
  candidate_tool: string;
  enabled: boolean;
  created_at: string;
}

// --- Feature 9: Hybrid Authoring (Rule Templates) ---
interface RuleTemplateParam {
  name: string;
  type: string;
  description: string;
  example: string;
}

interface RuleTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  parameters: RuleTemplateParam[];
  template_rule: string;
  example_output: string;
}

// --- Feature 10: Semantic Interoperability ---
interface SemanticMapping {
  operational_term: string;
  analytical_term: string;
  description: string;
  entity?: string;
  field?: string;
  transformation?: string;
  examples?: string[];
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
    // ---- Feature 1: Dynamic Tool Exposure ----
    {
      name: "list_microflows",
      description:
        "Lists all registered business microflows/functions that are automatically exposed as MCP tools. Each entry shows inputs, outputs, steps, and ownership. Use this to discover what business logic is available before generating code that calls it.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_microflow",
      description:
        "Returns the full specification for a named microflow: all inputs/outputs, execution steps, tags, and async behavior. Call this before implementing code that invokes the microflow.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Microflow name, e.g. 'CalculateShippingCost'. Call list_microflows to see all.",
          },
        },
        required: ["name"],
      },
    },
    // ---- Feature 2: Rules Engine (Decision Tables / DMN) ----
    {
      name: "list_decision_tables",
      description:
        "Lists all registered DMN-style decision tables with their hit policies and a description. Use this to discover available decision tables for pricing, eligibility, and approval logic.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "evaluate_decision_table",
      description:
        "Evaluates a named decision table against a set of input values and returns the matching output(s). Respects the table's hit policy (FIRST, COLLECT, UNIQUE, RULE_ORDER). Use this to apply complex business rules without hard-coding conditions.",
      inputSchema: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "Decision table ID. Call list_decision_tables to see all available tables.",
          },
          inputs: {
            type: "object",
            description: "Key-value map of input field names to their values for this evaluation.",
          },
        },
        required: ["table_id", "inputs"],
      },
    },
    // ---- Feature 3: State Management & UI Automation ----
    {
      name: "list_ui_workflows",
      description:
        "Lists all registered multi-step UI workflows (checkout, refund, onboarding, etc.) with their initial step and terminal states. Use this to understand what agent-navigable flows exist.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_ui_workflow_step",
      description:
        "Returns the definition of a specific step within a UI workflow: fields to fill, available actions, validation rules, and which step each action leads to. Use this when automating form navigation or building an agent that drives a UI flow.",
      inputSchema: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "Workflow ID, e.g. 'checkout_flow'. Call list_ui_workflows to see all.",
          },
          step_id: {
            type: "string",
            description: "Step ID within the workflow, e.g. 'payment'. Omit to get the initial step.",
          },
        },
        required: ["workflow_id"],
      },
    },
    // ---- Feature 4: Bulk & Real-Time Processing ----
    {
      name: "evaluate_realtime_decision",
      description:
        "Performs a synchronous sub-100ms decision by evaluating a named decision table and returning the first matching output. Designed for hot-path use cases like pricing, eligibility checks, and routing decisions.",
      inputSchema: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "Decision table ID to evaluate.",
          },
          inputs: {
            type: "object",
            description: "Input values for the decision.",
          },
        },
        required: ["table_id", "inputs"],
      },
    },
    {
      name: "plan_batch_operation",
      description:
        "Returns guidance and constraints for implementing a high-volume batch operation on an entity — including idempotency requirements, event-bus guarantees, and concurrency limits. Use this before writing any bulk processing code.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "The entity being batch-processed, e.g. 'Order', 'User'.",
          },
          operation: {
            type: "string",
            description: "The operation to perform in bulk, e.g. 'status_update', 'cancel', 'export'.",
          },
        },
        required: ["entity", "operation"],
      },
    },
    // ---- Feature 5: Governance & Security ----
    {
      name: "check_permission",
      description:
        "Checks whether a given role is allowed to perform an action on an entity, and returns the conditions and any explicit denials. Call this before generating any code that modifies data on behalf of a user.",
      inputSchema: {
        type: "object",
        properties: {
          role: {
            type: "string",
            description: "User role, e.g. 'consumer', 'support', 'admin', 'seller'.",
          },
          entity: {
            type: "string",
            description: "Entity name, e.g. 'Order', 'User'.",
          },
          action: {
            type: "string",
            description: "Action to check, e.g. 'cancel', 'read_any', 'modify'.",
          },
        },
        required: ["role", "entity", "action"],
      },
    },
    {
      name: "record_audit_event",
      description:
        "Records an action in the audit trail with actor, role, entity, and details. Call this whenever an agent performs a write operation so there is a tamper-evident log entry.",
      inputSchema: {
        type: "object",
        properties: {
          actor_id: { type: "string", description: "ID of the user or agent performing the action." },
          role: { type: "string", description: "Role of the actor." },
          action: { type: "string", description: "Action performed, e.g. 'cancel_order'." },
          entity: { type: "string", description: "Entity type affected, e.g. 'Order'." },
          entity_id: { type: "string", description: "ID of the specific entity instance." },
          details: { type: "string", description: "Human-readable description of the change." },
        },
        required: ["actor_id", "role", "action", "entity", "entity_id", "details"],
      },
    },
    {
      name: "get_audit_trail",
      description:
        "Returns recent audit log entries, optionally filtered by entity or actor. Use this to review what actions have been taken and verify governance compliance.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Optional entity type to filter by." },
          actor_id: { type: "string", description: "Optional actor ID to filter by." },
          limit: { type: "number", description: "Max number of entries to return (default 20)." },
        },
      },
    },
    // ---- Feature 6: Multi-Scenario Logic Reuse ----
    {
      name: "list_rulesets",
      description:
        "Lists all reusable rulesets (logic components) with their versions, descriptions, and the services that consume them. Use this to understand shared logic before modifying rules that may have cross-app impact.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_ruleset",
      description:
        "Returns the full set of rules in a named ruleset, including conditions, actions, priorities, and where the ruleset is reused. Call this before implementing logic that should align with or call an existing ruleset.",
      inputSchema: {
        type: "object",
        properties: {
          ruleset_id: {
            type: "string",
            description: "Ruleset ID, e.g. 'order_validation'. Call list_rulesets to see all.",
          },
        },
        required: ["ruleset_id"],
      },
    },
    // ---- Feature 7: Production Debugging ----
    {
      name: "get_execution_log",
      description:
        "Returns recent tool execution history for this MCP server session, with tool name, inputs summary, output summary, and duration. Use this to audit what logic has been invoked and debug unexpected results.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Optional tool name to filter by." },
          limit: { type: "number", description: "Max entries to return (default 20)." },
        },
      },
    },
    {
      name: "register_shadow_test",
      description:
        "Registers a shadow test that tracks side-by-side executions of two tools (baseline vs candidate) for comparison. Returns the test ID. Use this to safely evaluate new logic against production behavior.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique test identifier." },
          description: { type: "string", description: "What is being compared." },
          baseline_tool: { type: "string", description: "Name of the currently deployed tool." },
          candidate_tool: { type: "string", description: "Name of the new tool being tested." },
        },
        required: ["id", "description", "baseline_tool", "candidate_tool"],
      },
    },
    {
      name: "get_monitoring_stats",
      description:
        "Returns real-time monitoring statistics for this MCP server: uptime, total tool invocations, per-tool call counts, and registered shadow tests. Use this to observe logic execution patterns.",
      inputSchema: { type: "object", properties: {} },
    },
    // ---- Feature 8: Offline & Edge Execution ----
    {
      name: "export_offline_bundle",
      description:
        "Exports a self-contained, portable JSON bundle of all business rules, decision tables, state machines, rulesets, and permissions for a given entity (or all entities). This bundle can be embedded in a client-side or edge engine to execute critical business logic locally when network connectivity is unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "Optional entity name to scope the bundle. Omit to export everything.",
          },
          include_decision_tables: {
            type: "boolean",
            description: "Include decision tables in the export (default true).",
          },
          include_rulesets: {
            type: "boolean",
            description: "Include rulesets in the export (default true).",
          },
          include_permissions: {
            type: "boolean",
            description: "Include permission definitions in the export (default true).",
          },
        },
      },
    },
    // ---- Feature 9: Hybrid Authoring ----
    {
      name: "list_rule_templates",
      description:
        "Lists all available visual rule templates with their categories and parameters. Templates let business experts define rules using structured forms — no code required. Developers can also use them as starting points for scripted rules.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional category filter (e.g. 'Validation', 'Governance')." },
        },
      },
    },
    {
      name: "apply_rule_template",
      description:
        "Applies a named rule template with provided parameter values and returns the generated rule definition. Use this to create rules from the visual builder's template library without writing raw condition syntax.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: {
            type: "string",
            description: "Template ID. Call list_rule_templates to see all available templates.",
          },
          parameters: {
            type: "object",
            description: "Key-value map of template parameter names to their values.",
          },
        },
        required: ["template_id", "parameters"],
      },
    },
    // ---- Feature 10: Semantic Interoperability ----
    {
      name: "list_semantic_mappings",
      description:
        "Lists all mappings between operational (transactional) terms and analytical (KPI/BI) terms. Use this to understand how operational field values translate to analytics concepts when building reports, dashboards, or data pipelines.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Optional entity to filter mappings by." },
        },
      },
    },
    {
      name: "get_semantic_mapping",
      description:
        "Returns the full semantic mapping for a specific operational term, including the corresponding analytical term, SQL transformation pattern, and usage examples. Use this before writing analytical queries to ensure correct business meaning is preserved.",
      inputSchema: {
        type: "object",
        properties: {
          operational_term: {
            type: "string",
            description: "The operational term to look up, e.g. 'Order.total_amount' or 'Invoice.status = paid'. Call list_semantic_mappings to see all.",
          },
        },
        required: ["operational_term"],
      },
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

    // =========================================================================
    // FEATURE 1: Dynamic Tool Exposure — Microflows
    // =========================================================================
    case "list_microflows": {
      const t0 = Date.now();
      const result = Object.values(MICROFLOWS).map((mf) => ({
        name: mf.name,
        description: mf.description,
        tags: mf.tags,
        owner: mf.owner,
        async: mf.async,
        input_count: mf.inputs.length,
        output_count: mf.outputs.length,
      }));
      logExecution("list_microflows", args, `${result.length} microflows`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_microflow": {
      const t0 = Date.now();
      const mfName = args.name as string | undefined;
      if (!mfName) {
        return { content: [{ type: "text", text: "Missing required argument: 'name'." }], isError: true };
      }
      const mf = MICROFLOWS[mfName];
      if (!mf) {
        const available = Object.keys(MICROFLOWS).join(", ");
        return {
          content: [{ type: "text", text: `Microflow '${mfName}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      logExecution("get_microflow", args, mfName, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(mf, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 2: Rules Engine — Decision Tables (DMN)
    // =========================================================================
    case "list_decision_tables": {
      const t0 = Date.now();
      const result = Object.values(DECISION_TABLES).map((dt) => ({
        id: dt.id,
        description: dt.description,
        hitPolicy: dt.hitPolicy,
        inputs: dt.inputs.map((i) => i.name),
        outputs: dt.outputs.map((o) => o.name),
        row_count: dt.rows.length,
      }));
      logExecution("list_decision_tables", args, `${result.length} tables`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "evaluate_decision_table": {
      const t0 = Date.now();
      const tableId = args.table_id as string | undefined;
      const inputs = (args.inputs ?? {}) as Record<string, unknown>;
      if (!tableId) {
        return { content: [{ type: "text", text: "Missing required argument: 'table_id'." }], isError: true };
      }
      const dt = DECISION_TABLES[tableId];
      if (!dt) {
        const available = Object.keys(DECISION_TABLES).join(", ");
        return {
          content: [{ type: "text", text: `Decision table '${tableId}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      // Evaluate rows according to hit policy
      const matchingRows: { row_id: string; outputs: Record<string, unknown>; annotation?: string }[] = [];
      const sortedRows = [...dt.rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      for (const row of sortedRows) {
        if (rowMatchesInputs(row.conditions, inputs)) {
          matchingRows.push({ row_id: row.id, outputs: row.outputs, annotation: row.annotation });
          if (dt.hitPolicy === "FIRST" || dt.hitPolicy === "UNIQUE") break;
        }
      }
      const result = {
        table_id: tableId,
        hit_policy: dt.hitPolicy,
        inputs_provided: inputs,
        matched_rows: matchingRows,
        outputs: matchingRows.length > 0 ? (dt.hitPolicy === "COLLECT" ? matchingRows.map((r) => r.outputs) : matchingRows[0].outputs) : null,
        no_match: matchingRows.length === 0,
      };
      logExecution("evaluate_decision_table", args, `${matchingRows.length} rows matched`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 3: State Management & UI Automation
    // =========================================================================
    case "list_ui_workflows": {
      const t0 = Date.now();
      const result = Object.values(UI_WORKFLOWS).map((wf) => ({
        id: wf.id,
        description: wf.description,
        initial_step: wf.initial,
        terminal_steps: wf.terminal_steps,
        step_count: Object.keys(wf.steps).length,
        steps: Object.keys(wf.steps),
      }));
      logExecution("list_ui_workflows", args, `${result.length} workflows`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_ui_workflow_step": {
      const t0 = Date.now();
      const workflowId = args.workflow_id as string | undefined;
      if (!workflowId) {
        return { content: [{ type: "text", text: "Missing required argument: 'workflow_id'." }], isError: true };
      }
      const wf = UI_WORKFLOWS[workflowId];
      if (!wf) {
        const available = Object.keys(UI_WORKFLOWS).join(", ");
        return {
          content: [{ type: "text", text: `Workflow '${workflowId}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      const stepId = (args.step_id as string | undefined) ?? wf.initial;
      const step = wf.steps[stepId];
      if (!step) {
        const available = Object.keys(wf.steps).join(", ");
        return {
          content: [{ type: "text", text: `Step '${stepId}' not found in workflow '${workflowId}'. Available: ${available}` }],
          isError: true,
        };
      }
      const result = {
        workflow_id: workflowId,
        ...step,
        is_terminal: wf.terminal_steps.includes(step.id),
      };
      logExecution("get_ui_workflow_step", args, `${workflowId}/${stepId}`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 4: Bulk & Real-Time Processing
    // =========================================================================
    case "evaluate_realtime_decision": {
      const t0 = Date.now();
      const tableId = args.table_id as string | undefined;
      const inputs = (args.inputs ?? {}) as Record<string, unknown>;
      if (!tableId) {
        return { content: [{ type: "text", text: "Missing required argument: 'table_id'." }], isError: true };
      }
      const dt = DECISION_TABLES[tableId];
      if (!dt) {
        return { content: [{ type: "text", text: `Decision table '${tableId}' not found.` }], isError: true };
      }
      const sortedRows = [...dt.rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      const firstMatch = sortedRows.find((row) => rowMatchesInputs(row.conditions, inputs)) ?? null;
      const duration = Date.now() - t0;
      const result = {
        table_id: tableId,
        latency_ms: duration,
        matched: firstMatch !== null,
        outputs: firstMatch?.outputs ?? null,
        annotation: firstMatch?.annotation ?? null,
      };
      logExecution("evaluate_realtime_decision", args, firstMatch ? "matched" : "no match", duration);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "plan_batch_operation": {
      const t0 = Date.now();
      const entity = args.entity as string | undefined;
      const operation = args.operation as string | undefined;
      if (!entity || !operation) {
        return { content: [{ type: "text", text: "Missing required arguments: 'entity' and 'operation'." }], isError: true };
      }
      const entityDef = BUSINESS_LOGIC.entities[entity];
      const guidance = {
        entity,
        operation,
        batch_guidance: {
          idempotency: "All batch operations MUST be idempotent. Use a job_id or batch_id as the idempotency key.",
          event_bus: "The Kafka event bus delivers at-least-once. Batch consumers must deduplicate by entity ID + job ID.",
          chunk_size: "Process in chunks of 100–500 records. Commit offsets after each successful chunk.",
          error_handling: "Log failures per-record. Do not abort the whole batch on a single failure — use a dead-letter queue.",
          concurrency: "Use distributed locks (Redis) if the operation touches shared state. Avoid row-level locks for batches over 1000.",
          monitoring: "Emit a progress event every 1000 records: { job_id, processed, failed, remaining }.",
          async_pattern: "Batch jobs are async by design. Expose a /jobs/:id status endpoint — never block the caller.",
        },
        entity_specific_notes: entityDef ? entityDef.side_effects : [],
        known_footguns: entityDef ? entityDef.known_footguns : BUSINESS_LOGIC.global_footguns,
        global_footguns_relevant: [
          "Background jobs are idempotent by design. Do not add logic that assumes a job runs exactly once.",
          "The event bus (Kafka) delivers at-least-once. Consumers must be idempotent.",
        ],
      };
      logExecution("plan_batch_operation", args, `${entity}/${operation}`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(guidance, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 5: Governance & Security
    // =========================================================================
    case "check_permission": {
      const t0 = Date.now();
      const role = args.role as string | undefined;
      const entity = args.entity as string | undefined;
      const action = args.action as string | undefined;
      if (!role || !entity || !action) {
        return { content: [{ type: "text", text: "Missing required arguments: 'role', 'entity', 'action'." }], isError: true };
      }
      const rolePerms = PERMISSIONS[role];
      if (!rolePerms) {
        const available = Object.keys(PERMISSIONS).join(", ");
        return {
          content: [{ type: "text", text: `Role '${role}' not found. Available roles: ${available}` }],
          isError: true,
        };
      }
      const entityPerms = rolePerms[entity];
      if (!entityPerms) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                role,
                entity,
                action,
                allowed: false,
                reason: `No permissions defined for role '${role}' on entity '${entity}'.`,
              }, null, 2),
            },
          ],
        };
      }
      const explicitlyDenied = entityPerms.denied_actions.includes(action);
      const explicitlyAllowed =
        entityPerms.allowed_actions.includes(action) ||
        (entityPerms.allowed_actions.includes("read_any") && action.startsWith("read"));
      const result = {
        role,
        entity,
        action,
        allowed: explicitlyAllowed && !explicitlyDenied,
        explicitly_denied: explicitlyDenied,
        allowed_actions: entityPerms.allowed_actions,
        denied_actions: entityPerms.denied_actions,
        conditions: entityPerms.conditions,
      };
      logExecution("check_permission", args, result.allowed ? "allowed" : "denied", Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "record_audit_event": {
      const t0 = Date.now();
      const actorId = args.actor_id as string | undefined;
      const role = args.role as string | undefined;
      const action = args.action as string | undefined;
      const entity = args.entity as string | undefined;
      const entityId = args.entity_id as string | undefined;
      const details = args.details as string | undefined;
      if (!actorId || !role || !action || !entity || !entityId || !details) {
        return { content: [{ type: "text", text: "Missing required arguments for audit event." }], isError: true };
      }
      const entry: AuditLogEntry = {
        id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        actor_id: actorId,
        role,
        action,
        entity,
        entity_id: entityId,
        details,
      };
      AUDIT_LOG.push(entry);
      if (AUDIT_LOG.length > 1000) AUDIT_LOG.shift();
      logExecution("record_audit_event", args, `audit_id: ${entry.id}`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify({ recorded: true, audit_id: entry.id, timestamp: entry.timestamp }, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_audit_trail": {
      const t0 = Date.now();
      const filterEntity = args.entity as string | undefined;
      const filterActor = args.actor_id as string | undefined;
      const limit = Math.min(Number(args.limit ?? 20), 100);
      let entries = [...AUDIT_LOG].reverse();
      if (filterEntity) entries = entries.filter((e) => e.entity === filterEntity);
      if (filterActor) entries = entries.filter((e) => e.actor_id === filterActor);
      const result = entries.slice(0, limit);
      logExecution("get_audit_trail", args, `${result.length} entries`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify({ total_in_log: AUDIT_LOG.length, returned: result.length, entries: result }, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 6: Multi-Scenario Logic Reuse — Rulesets
    // =========================================================================
    case "list_rulesets": {
      const t0 = Date.now();
      const result = Object.values(RULESETS).map((rs) => ({
        id: rs.id,
        description: rs.description,
        version: rs.version,
        rule_count: rs.rules.length,
        reuse_in: rs.reuse_in,
        tags: rs.tags,
      }));
      logExecution("list_rulesets", args, `${result.length} rulesets`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_ruleset": {
      const t0 = Date.now();
      const rulesetId = args.ruleset_id as string | undefined;
      if (!rulesetId) {
        return { content: [{ type: "text", text: "Missing required argument: 'ruleset_id'." }], isError: true };
      }
      const rs = RULESETS[rulesetId];
      if (!rs) {
        const available = Object.keys(RULESETS).join(", ");
        return {
          content: [{ type: "text", text: `Ruleset '${rulesetId}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      logExecution("get_ruleset", args, rulesetId, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(rs, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 7: Production Debugging
    // =========================================================================
    case "get_execution_log": {
      const filterTool = args.tool as string | undefined;
      const limit = Math.min(Number(args.limit ?? 20), 100);
      let entries = [...EXECUTION_LOG].reverse();
      if (filterTool) entries = entries.filter((e) => e.tool === filterTool);
      const result = entries.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { total_executions: executionCounter, returned: result.length, entries: result },
              null,
              2
            ),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    case "register_shadow_test": {
      const t0 = Date.now();
      const id = args.id as string | undefined;
      const description = args.description as string | undefined;
      const baselineTool = args.baseline_tool as string | undefined;
      const candidateTool = args.candidate_tool as string | undefined;
      if (!id || !description || !baselineTool || !candidateTool) {
        return { content: [{ type: "text", text: "Missing required arguments for shadow test." }], isError: true };
      }
      const test: ShadowTest = {
        id,
        description,
        baseline_tool: baselineTool,
        candidate_tool: candidateTool,
        enabled: true,
        created_at: new Date().toISOString(),
      };
      SHADOW_TESTS[id] = test;
      logExecution("register_shadow_test", args, `test '${id}' registered`, Date.now() - t0);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ registered: true, shadow_test: test }, null, 2),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    case "get_monitoring_stats": {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const toolCounts: Record<string, number> = {};
      for (const entry of EXECUTION_LOG) {
        toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;
      }
      const avgDuration = EXECUTION_LOG.length > 0
        ? Math.round(EXECUTION_LOG.reduce((sum, e) => sum + e.duration_ms, 0) / EXECUTION_LOG.length)
        : 0;
      const result = {
        uptime_ms: uptimeMs,
        uptime_human: `${Math.floor(uptimeMs / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
        total_tool_invocations: executionCounter,
        audit_log_entries: AUDIT_LOG.length,
        shadow_tests_registered: Object.keys(SHADOW_TESTS).length,
        shadow_tests: Object.values(SHADOW_TESTS),
        avg_tool_duration_ms: avgDuration,
        tool_invocation_counts: toolCounts,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 8: Offline & Edge Execution
    // =========================================================================
    case "export_offline_bundle": {
      const t0 = Date.now();
      const scopeEntity = args.entity as string | undefined;
      const includeDecisionTables = args.include_decision_tables !== false;
      const includeRulesets = args.include_rulesets !== false;
      const includePermissions = args.include_permissions !== false;

      const bundle: Record<string, unknown> = {
        bundle_version: "1.0",
        exported_at: new Date().toISOString(),
        scope: scopeEntity ?? "all",
        readme: [
          "This bundle is a self-contained snapshot of business rules for offline/edge execution.",
          "Embed in a client-side rules engine to evaluate logic without network access.",
          "Re-export when rules change — the exported_at timestamp identifies the version.",
        ],
        entities: scopeEntity
          ? { [scopeEntity]: BUSINESS_LOGIC.entities[scopeEntity] ?? null }
          : BUSINESS_LOGIC.entities,
        state_machines: scopeEntity
          ? Object.fromEntries(Object.entries(BUSINESS_LOGIC.state_machines).filter(([k]) => k.startsWith(scopeEntity ?? "")))
          : BUSINESS_LOGIC.state_machines,
        global_footguns: BUSINESS_LOGIC.global_footguns,
      };
      if (includeDecisionTables) {
        bundle.decision_tables = scopeEntity
          ? Object.fromEntries(Object.entries(DECISION_TABLES).filter(([, dt]) => dt.description.toLowerCase().includes((scopeEntity ?? "").toLowerCase())))
          : DECISION_TABLES;
      }
      if (includeRulesets) {
        bundle.rulesets = scopeEntity
          ? Object.fromEntries(Object.entries(RULESETS).filter(([, rs]) => rs.tags.includes((scopeEntity ?? "").toLowerCase())))
          : RULESETS;
      }
      if (includePermissions) {
        bundle.permissions = PERMISSIONS;
      }
      logExecution("export_offline_bundle", args, `bundle for '${scopeEntity ?? "all"}'`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 9: Hybrid Authoring — Rule Templates
    // =========================================================================
    case "list_rule_templates": {
      const t0 = Date.now();
      const categoryFilter = args.category as string | undefined;
      let templates = Object.values(RULE_TEMPLATES);
      if (categoryFilter) {
        templates = templates.filter((t) => t.category.toLowerCase() === categoryFilter.toLowerCase());
      }
      const result = templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        parameters: t.parameters.map((p) => p.name),
        example_output: t.example_output,
      }));
      logExecution("list_rule_templates", args, `${result.length} templates`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "apply_rule_template": {
      const t0 = Date.now();
      const templateId = args.template_id as string | undefined;
      const parameters = (args.parameters ?? {}) as Record<string, string>;
      if (!templateId) {
        return { content: [{ type: "text", text: "Missing required argument: 'template_id'." }], isError: true };
      }
      const tmpl = RULE_TEMPLATES[templateId];
      if (!tmpl) {
        const available = Object.keys(RULE_TEMPLATES).join(", ");
        return {
          content: [{ type: "text", text: `Template '${templateId}' not found. Available: ${available}` }],
          isError: true,
        };
      }
      const missingParams = tmpl.parameters
        .filter((p) => !(p.name in parameters))
        .map((p) => p.name);
      if (missingParams.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Missing template parameters",
                missing: missingParams,
                required_parameters: tmpl.parameters,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
      let generatedRule = tmpl.template_rule;
      for (const [key, value] of Object.entries(parameters)) {
        generatedRule = generatedRule.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
      }
      const result = {
        template_id: templateId,
        template_name: tmpl.name,
        category: tmpl.category,
        parameters_used: parameters,
        generated_rule: generatedRule,
        note: "Review this generated rule before adding it to a ruleset or decision table.",
      };
      logExecution("apply_rule_template", args, templateId, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // =========================================================================
    // FEATURE 10: Semantic Interoperability
    // =========================================================================
    case "list_semantic_mappings": {
      const t0 = Date.now();
      const entityFilter = args.entity as string | undefined;
      let mappings = SEMANTIC_MAPPINGS;
      if (entityFilter) {
        mappings = mappings.filter((m) => m.entity === entityFilter);
      }
      const result = mappings.map((m) => ({
        operational_term: m.operational_term,
        analytical_term: m.analytical_term,
        entity: m.entity,
        field: m.field,
        description: m.description,
      }));
      logExecution("list_semantic_mappings", args, `${result.length} mappings`, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // -------------------------------------------------------------------------
    case "get_semantic_mapping": {
      const t0 = Date.now();
      const operationalTerm = args.operational_term as string | undefined;
      if (!operationalTerm) {
        return { content: [{ type: "text", text: "Missing required argument: 'operational_term'." }], isError: true };
      }
      const mapping = SEMANTIC_MAPPINGS.find(
        (m) => m.operational_term.toLowerCase() === operationalTerm.toLowerCase()
      );
      if (!mapping) {
        const available = SEMANTIC_MAPPINGS.map((m) => m.operational_term);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `No mapping found for '${operationalTerm}'.`,
                available_operational_terms: available,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
      logExecution("get_semantic_mapping", args, mapping.analytical_term, Date.now() - t0);
      return { content: [{ type: "text", text: JSON.stringify(mapping, null, 2) }] };
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
