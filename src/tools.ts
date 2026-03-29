/**
 * Fact Bus Tools for OpenClaw Agent
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { FactBusClient } from "./api.js";
import {
  pendingEvents,
  consumeDroppedPendingCount,
} from "./pending-events.js";
import type {
  PublishFactParams,
  QueryFactsToolParams,
  ClaimFactParams,
  ResolveFactParams,
  ValidateFactParams,
  SenseFactParams,
  GetSchemaParams,
  ReleaseFactParams,
  Fact,
  SemanticKind,
  FactMode,
} from "./types.js";

/** Standard tool return shape for OpenClaw / pi-agent-core */
export type FactBusToolResult = AgentToolResult<Record<string, unknown>>;

const semanticKindUnion = Type.Union(
  [
    Type.Literal("observation"),
    Type.Literal("assertion"),
    Type.Literal("request"),
    Type.Literal("resolution"),
    Type.Literal("correction"),
    Type.Literal("signal"),
  ],
  { description: "Semantic classification of the fact" }
);

export interface ToolContext {
  client: FactBusClient;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function actionHintForFact(
  semanticKind: SemanticKind | undefined,
  mode: FactMode | undefined
): string {
  const sk = semanticKind ?? "observation";
  const m = mode ?? "exclusive";

  if (sk === "request" && m === "exclusive") {
    return "This fact requests action (exclusive). Call fact_bus_claim to claim it, process it, then fact_bus_resolve (or fact_bus_release if you cannot handle it).";
  }
  if (sk === "request" && m === "broadcast") {
    return "This fact requests action from all capable claws. Process and publish results via fact_bus_publish (optionally with parent_fact_id for causation).";
  }
  if (sk === "observation") {
    return "New observation. You may corroborate or contradict via fact_bus_validate, or publish derived analysis with fact_bus_publish.";
  }
  if (sk === "assertion") {
    return "An inference by another claw. Validate if you can confirm or dispute it (fact_bus_validate) or publish a counter-analysis.";
  }
  if (sk === "correction") {
    return "A previous fact has been corrected. Review the updated information and adjust your plan.";
  }
  if (sk === "resolution") {
    return "A task has been completed. Review the results; no claim needed unless you must follow up.";
  }
  if (sk === "signal") {
    return "Status signal. No action needed unless relevant to your domain.";
  }
  return "Review this fact and decide whether to claim, validate, or publish.";
}

function factSummaryForSense(f: Fact) {
  return {
    fact_id: f.fact_id,
    fact_type: f.fact_type,
    semantic_kind: f.semantic_kind,
    payload: f.payload,
    confidence: f.confidence,
    epistemic_state: f.epistemic_state,
    mode: f.mode,
    causation_depth: f.causation_depth,
    state: f.state,
    claimed_by: f.claimed_by,
    parent_fact_id: f.parent_fact_id,
  };
}

// ============ Sense Facts Tool ============

export const senseFactTool = {
  name: "fact_bus_sense",
  description:
    "Check for new facts pushed from the Fact Bus (WebSocket). Call this periodically to sense what is happening on the bus. Returns drained pending events with facts and action guidance (what to do next). If events_dropped > 0, events were lost due to queue overflow; use fact_bus_query to catch up.",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 100,
        description: "Max events to drain per call (default: 10)",
      })
    ),
  }),

  async execute(
    _id: string,
    params: SenseFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { logger } = context;
    const limit = params.limit ?? 10;
    const drained = pendingEvents.splice(0, limit);
    const eventsDropped = consumeDroppedPendingCount();

    if (drained.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: 0,
                events_dropped: eventsDropped,
                message:
                  eventsDropped > 0
                    ? `No events in queue, but ${eventsDropped} event(s) were dropped earlier due to overflow; use fact_bus_query to poll.`
                    : "No pending bus events. Events arrive via WebSocket; call again after activity or use fact_bus_query to poll.",
              },
              null,
              2
            ),
          },
        ],
        details: {},
      };
    }

    logger.info(`fact_bus_sense drained ${drained.length} events`);

    const items = drained.map((event) => {
      const base = {
        event_type: event.event_type,
        timestamp: event.timestamp,
      };

      if (event.event_type === "fact_available" && event.fact) {
        const f = event.fact;
        return {
          ...base,
          fact: factSummaryForSense(f),
          action_hint: actionHintForFact(f.semantic_kind, f.mode),
        };
      }

      if (event.event_type === "fact_superseded" && event.fact) {
        const f = event.fact;
        return {
          ...base,
          fact: factSummaryForSense(f),
          action_hint:
            "This fact was superseded by newer knowledge. Prefer the latest fact for the same subject_key + fact_type.",
        };
      }

      if (event.event_type === "fact_trust_changed" && event.fact) {
        const f = event.fact;
        return {
          ...base,
          fact: factSummaryForSense(f),
          detail: event.detail,
          action_hint:
            "Trust level of this fact changed. Re-evaluate whether to rely on it; consider fact_bus_validate if you have independent evidence.",
        };
      }

      return {
        ...base,
        ...("claw_id" in event && event.claw_id ? { claw_id: event.claw_id } : {}),
        detail: event.detail,
        fact: event.fact ? factSummaryForSense(event.fact) : undefined,
        action_hint: "Review event detail and related facts.",
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: items.length,
              events_dropped: eventsDropped,
              events: items,
            },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Publish Fact Tool ============

export const publishFactTool = {
  name: "fact_bus_publish",
  description:
    "Publish a new fact to the Claw Fact Bus. Facts are immutable records that flow through the bus and can be sensed by other claws. Use semantic_kind to classify: 'observation' for sensed data, 'assertion' for inferences, 'request' for action requests, 'resolution' for completed work, 'correction' to update previous facts, 'signal' for status pings. Use parent_fact_id to link this fact to a prior fact (causation depth +1) without resolving the parent.",
  parameters: Type.Object({
    fact_type: Type.String({
      description:
        "Dot-notation fact type (e.g., 'code.review.needed', 'incident.latency.high')",
    }),
    payload: Type.Record(Type.String(), Type.Unknown(), {
      description: "Business data payload for this fact",
    }),
    semantic_kind: Type.Optional(
      Type.Union(
        [
          Type.Literal("observation"),
          Type.Literal("assertion"),
          Type.Literal("request"),
          Type.Literal("resolution"),
          Type.Literal("correction"),
          Type.Literal("signal"),
        ],
        { description: "Semantic kind of this fact (default: observation)" }
      )
    ),
    priority: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 7,
        description: "Priority 0-7 (lower = higher priority, default: 3)",
      })
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("broadcast"), Type.Literal("exclusive")], {
        description:
          "broadcast = anyone can process; exclusive = must be claimed first (default: exclusive)",
      })
    ),
    subject_key: Type.Optional(
      Type.String({
        description: "Groups facts about the same subject for knowledge evolution",
      })
    ),
    parent_fact_id: Type.Optional(
      Type.String({
        description:
          "ID of the parent fact this is derived from; builds causation_chain and increments causation_depth",
      })
    ),
    confidence: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Publisher's confidence in this fact 0-1 (default: 1.0)",
      })
    ),
    ttl_seconds: Type.Optional(
      Type.Number({ description: "Time to live in seconds (default: 300, min: 10)" })
    ),
    domain_tags: Type.Optional(
      Type.Array(Type.String(), { description: "Domain labels for categorization" })
    ),
    need_capabilities: Type.Optional(
      Type.Array(Type.String(), {
        description: "Required capabilities to process this fact",
      })
    ),
  }),

  async execute(
    _id: string,
    params: PublishFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to Fact Bus. Please check configuration.",
          },
        ],
        details: {},
      };
    }

    let causation_chain: string[] | undefined;
    let causation_depth: number | undefined;

    if (params.parent_fact_id) {
      const parentRes = await client.getFact(params.parent_fact_id);
      if (!parentRes.success || !parentRes.data) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to load parent fact ${params.parent_fact_id}: ${parentRes.error ?? "not found"}`,
            },
          ],
          details: {},
        };
      }
      const parent = parentRes.data;
      const chain = [...(parent.causation_chain || []), params.parent_fact_id];
      causation_chain = chain;
      causation_depth = (parent.causation_depth ?? 0) + 1;
    }

    logger.info("Publishing fact:", params.fact_type);

    const result = await client.publishFact({
      fact_type: params.fact_type,
      payload: params.payload,
      semantic_kind: params.semantic_kind,
      priority: params.priority,
      mode: params.mode,
      subject_key: params.subject_key,
      confidence: params.confidence,
      ttl_seconds: params.ttl_seconds,
      domain_tags: params.domain_tags,
      need_capabilities: params.need_capabilities,
      causation_chain,
      causation_depth,
    });

    if (!result.success) {
      logger.error("Failed to publish fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to publish fact: ${result.error}` }],
        details: {},
      };
    }

    const fact = result.data!;
    logger.info("Fact published:", fact.fact_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              fact_id: fact.fact_id,
              fact_type: fact.fact_type,
              state: fact.state,
              causation_depth: fact.causation_depth,
              causation_chain: fact.causation_chain,
              created_at: new Date(fact.created_at).toISOString(),
            },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Query Facts Tool ============

export const queryFactsTool = {
  name: "fact_bus_query",
  description:
    "Query facts from the Claw Fact Bus. Can filter by type, state, and source. Use together with fact_bus_sense for full coverage.",
  parameters: Type.Object({
    fact_type: Type.Optional(Type.String({ description: "Filter by fact type" })),
    state: Type.Optional(
      Type.Union(
        [
          Type.Literal("created"),
          Type.Literal("published"),
          Type.Literal("matched"),
          Type.Literal("claimed"),
          Type.Literal("processing"),
          Type.Literal("resolved"),
          Type.Literal("dead"),
        ],
        { description: "Filter by workflow state" }
      )
    ),
    source_claw_id: Type.Optional(
      Type.String({ description: "Filter by source claw ID" })
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 1000,
        description: "Maximum number of facts to return (default: 100)",
      })
    ),
  }),

  async execute(
    _id: string,
    params: QueryFactsToolParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    logger.debug("Querying facts:", params);

    const result = await client.queryFacts({
      fact_type: params.fact_type,
      state: params.state,
      source_claw_id: params.source_claw_id,
      limit: params.limit ?? 100,
    });

    if (!result.success) {
      logger.error("Failed to query facts:", result.error);
      return {
        content: [{ type: "text", text: `Failed to query facts: ${result.error}` }],
        details: {},
      };
    }

    const facts = result.data!;
    logger.info(`Found ${facts.length} facts`);

    const summary = facts.map((f: Fact) => ({
      fact_id: f.fact_id,
      fact_type: f.fact_type,
      state: f.state,
      confidence: f.confidence,
      created_at: new Date(f.created_at).toISOString(),
      subject_key: f.subject_key,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: facts.length, facts: summary }, null, 2),
        },
      ],
      details: {},
    };
  },
};

// ============ Claim Fact Tool ============

export const claimFactTool = {
  name: "fact_bus_claim",
  description:
    "Claim an exclusive fact for processing. Only one claw can claim a fact at a time. Only needed for exclusive-mode facts. After claiming, you must either resolve (fact_bus_resolve) or release (fact_bus_release) the fact.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to claim" }),
  }),

  async execute(
    _id: string,
    params: ClaimFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
        details: {},
      };
    }

    logger.info("Claiming fact:", params.fact_id);

    const result = await client.claimFact(params.fact_id);

    if (!result.success) {
      logger.error("Failed to claim fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to claim fact: ${result.error}` }],
        details: {},
      };
    }

    logger.info("Fact claimed:", params.fact_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              fact_id: result.data!.fact_id,
              claimed_by: result.data!.claimed_by,
            },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Release Fact Tool ============

export const releaseFactTool = {
  name: "fact_bus_release",
  description:
    "Release a previously claimed exclusive fact back to the bus so other claws can claim it. Use when you cannot complete the work.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to release" }),
  }),

  async execute(
    _id: string,
    params: ReleaseFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
        details: {},
      };
    }

    logger.info("Releasing fact:", params.fact_id);

    const result = await client.releaseFact(params.fact_id);

    if (!result.success) {
      logger.error("Failed to release fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to release fact: ${result.error}` }],
        details: {},
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: true, fact_id: result.data!.fact_id },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Resolve Fact Tool ============

export const resolveFactTool = {
  name: "fact_bus_resolve",
  description:
    "Mark a claimed fact as resolved. Optionally emit child facts as results. Child facts automatically inherit the causation chain (depth +1). Use result_facts to emit findings for other claws to sense; set semantic_kind on each child (often 'resolution' for outcomes).",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to resolve" }),
    result_facts: Type.Optional(
      Type.Array(
        Type.Object({
          fact_type: Type.String(),
          semantic_kind: Type.Optional(semanticKindUnion),
          payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          domain_tags: Type.Optional(Type.Array(Type.String())),
          need_capabilities: Type.Optional(Type.Array(Type.String())),
          priority: Type.Optional(Type.Number()),
          mode: Type.Optional(Type.String()),
        }),
        { description: "Optional child facts to emit as results" }
      )
    ),
  }),

  async execute(
    _id: string,
    params: ResolveFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
        details: {},
      };
    }

    logger.info("Resolving fact:", params.fact_id);

    const result = await client.resolveFact(params.fact_id, params.result_facts);

    if (!result.success) {
      logger.error("Failed to resolve fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to resolve fact: ${result.error}` }],
        details: {},
      };
    }

    logger.info("Fact resolved:", params.fact_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              fact_id: result.data!.fact_id,
            },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Validate Fact Tool ============

export const validateFactTool = {
  name: "fact_bus_validate",
  description:
    "Corroborate or contradict a fact for social validation and consensus. Use 'corroborate' when you independently verify a fact is correct. Use 'contradict' when your evidence disagrees. This affects the fact's trust level (epistemic state).",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to validate" }),
    action: Type.Union([Type.Literal("corroborate"), Type.Literal("contradict")], {
      description: "corroborate = confirm; contradict = dispute",
    }),
  }),

  async execute(
    _id: string,
    params: ValidateFactParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
        details: {},
      };
    }

    logger.info(`${params.action} fact:`, params.fact_id);

    const result =
      params.action === "corroborate"
        ? await client.corroborateFact(params.fact_id)
        : await client.contradictFact(params.fact_id);

    if (!result.success) {
      logger.error(`Failed to ${params.action} fact:`, result.error);
      return {
        content: [
          { type: "text", text: `Failed to ${params.action} fact: ${result.error}` },
        ],
        details: {},
      };
    }

    logger.info(`Fact ${params.action}d:`, params.fact_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              fact_id: result.data!.fact_id,
              action: params.action,
              epistemic_state: result.data!.epistemic_state,
            },
            null,
            2
          ),
        },
      ],
      details: {},
    };
  },
};

// ============ Get Schema Tool ============

export const getSchemaFactTool = {
  name: "fact_bus_get_schema",
  description:
    "Get the registered schema for a fact type. Shows required fields, types, and descriptions so you know what payload to construct or how to interpret an incoming fact. Use fact_bus_query or fact_bus_sense to see live facts first.",
  parameters: Type.Object({
    fact_type: Type.String({
      description: "Dot-notation fact type (e.g. 'code.review.needed')",
    }),
  }),

  async execute(
    _id: string,
    params: GetSchemaParams,
    context: ToolContext
  ): Promise<FactBusToolResult> {
    const { client, logger } = context;

    logger.debug("Fetching schema for:", params.fact_type);

    const result = await client.getSchema(params.fact_type);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get schema: ${result.error ?? "unknown error"}`,
          },
        ],
        details: {},
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
      details: {},
    };
  },
};

// ============ Export all tools ============

export const factBusTools = [
  senseFactTool,
  publishFactTool,
  queryFactsTool,
  claimFactTool,
  releaseFactTool,
  resolveFactTool,
  validateFactTool,
  getSchemaFactTool,
];
