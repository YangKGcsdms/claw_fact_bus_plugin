/**
 * Fact Bus Tools for OpenClaw Agent
 */

import { Type } from "@sinclair/typebox";
import type { FactBusClient } from "./api.js";
import type {
  PublishFactParams,
  QueryFactsToolParams,
  ClaimFactParams,
  ResolveFactParams,
  ValidateFactParams,
  ReleaseFactParams,
  Fact,
} from "./types.js";

export interface ToolContext {
  client: FactBusClient;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// ============ Publish Fact Tool ============

export const publishFactTool = {
  name: "fact_bus_publish",
  description:
    "Publish a new fact to the Claw Fact Bus. Facts are immutable records that flow through the bus and can be sensed by other claws.",
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
      Type.Union(
        [Type.Literal("broadcast"), Type.Literal("exclusive")],
        {
          description: "broadcast = anyone can process; exclusive = must be claimed first (default: exclusive)",
        }
      )
    ),
    subject_key: Type.Optional(
      Type.String({
        description: "Groups facts about the same subject for knowledge evolution",
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
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to Fact Bus. Please check configuration.",
          },
        ],
      };
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
      source_claw_id: client.currentClawId || "",
    });

    if (!result.success) {
      logger.error("Failed to publish fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to publish fact: ${result.error}` }],
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
              created_at: new Date(fact.created_at).toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  },
};

// ============ Query Facts Tool ============

export const queryFactsTool = {
  name: "fact_bus_query",
  description:
    "Query facts from the Claw Fact Bus. Can filter by type, state, and source.",
  parameters: Type.Object({
    fact_type: Type.Optional(
      Type.String({ description: "Filter by fact type" })
    ),
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
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
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
    };
  },
};

// ============ Claim Fact Tool ============

export const claimFactTool = {
  name: "fact_bus_claim",
  description:
    "Claim an exclusive fact for processing. Only one claw can claim a fact at a time.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to claim" }),
  }),

  async execute(
    _id: string,
    params: ClaimFactParams,
    context: ToolContext
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [
          { type: "text", text: "Error: Not connected to Fact Bus." },
        ],
      };
    }

    logger.info("Claiming fact:", params.fact_id);

    const result = await client.claimFact(params.fact_id);

    if (!result.success) {
      logger.error("Failed to claim fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to claim fact: ${result.error}` }],
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
    };
  },
};

// ============ Release Fact Tool ============

export const releaseFactTool = {
  name: "fact_bus_release",
  description:
    "Release a claimed fact back to the pool. Use this if you cannot complete processing and want to let other claws claim it.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to release" }),
  }),

  async execute(
    _id: string,
    params: ReleaseFactParams,
    context: ToolContext
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [
          { type: "text", text: "Error: Not connected to Fact Bus." },
        ],
      };
    }

    logger.info("Releasing fact:", params.fact_id);

    const result = await client.releaseFact(params.fact_id);

    if (!result.success) {
      logger.error("Failed to release fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to release fact: ${result.error}` }],
      };
    }

    logger.info("Fact released:", params.fact_id);

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
    };
  },
};

// ============ Resolve Fact Tool ============

export const resolveFactTool = {
  name: "fact_bus_resolve",
  description:
    "Mark a claimed fact as resolved. Optionally emit child facts as results.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to resolve" }),
    result_facts: Type.Optional(
      Type.Array(
        Type.Object({
          fact_type: Type.String(),
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
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
      };
    }

    logger.info("Resolving fact:", params.fact_id);

    const result = await client.resolveFact(params.fact_id, params.result_facts);

    if (!result.success) {
      logger.error("Failed to resolve fact:", result.error);
      return {
        content: [{ type: "text", text: `Failed to resolve fact: ${result.error}` }],
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
    };
  },
};

// ============ Validate Fact Tool ============

export const validateFactTool = {
  name: "fact_bus_validate",
  description:
    "Corroborate or contradict a fact. Used for social validation and consensus building.",
  parameters: Type.Object({
    fact_id: Type.String({ description: "The ID of the fact to validate" }),
    action: Type.Union(
      [Type.Literal("corroborate"), Type.Literal("contradict")],
      { description: "corroborate = confirm; contradict = dispute" }
    ),
  }),

  async execute(
    _id: string,
    params: ValidateFactParams,
    context: ToolContext
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { client, logger } = context;

    if (!client.isConnected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to Fact Bus." }],
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
    };
  },
};

// ============ Export all tools ============

export const factBusTools = [
  publishFactTool,
  queryFactsTool,
  claimFactTool,
  releaseFactTool,
  resolveFactTool,
  validateFactTool,
];
