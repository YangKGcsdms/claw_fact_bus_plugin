/**
 * Claw Fact Bus OpenClaw Plugin Entry Point
 *
 * Architecture: When a fact arrives via WebSocket, we spawn a subagent
 * to process it autonomously (like a Channel plugin triggering on message).
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginConfigSchema,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { ServerResponse } from "node:http";
import { FactBusClient } from "./src/api.js";
import { factBusTools, type ToolContext } from "./src/tools.js";
import { FactBusWebSocketService } from "./src/websocket.js";
import { MAX_PENDING, pushPendingEvent } from "./src/pending-events.js";
import type { FactBusPluginConfig, BusEvent, Fact } from "./src/types.js";

// Runtime reference for spawning subagents
let pluginApi: OpenClawPluginApi | null = null;

function wrapPluginLogger(log: PluginLogger): ToolContext["logger"] {
  const join = (args: unknown[]) =>
    args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(" ");
  return {
    debug: (...args: unknown[]) => {
      log.debug?.(join(args));
    },
    info: (...args: unknown[]) => {
      log.info(join(args));
    },
    warn: (...args: unknown[]) => {
      log.warn(join(args));
    },
    error: (...args: unknown[]) => {
      log.error(join(args));
    },
  };
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// Plugin-level state
let client: FactBusClient | null = null;
let wsService: FactBusWebSocketService | null = null;
let wsServiceClawId: string | null = null;

const STARTUP_CONNECT_MAX_ATTEMPTS = 30;
const STARTUP_CONNECT_BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default definePluginEntry({
  id: "fact-bus",
  name: "Claw Fact Bus Plugin",
  description: "Integrates OpenClaw with Claw Fact Bus for fact-driven autonomous agent coordination",
  configSchema: Type.Object({
    busUrl: Type.String({ default: "http://localhost:8080" }),
    clawName: Type.Optional(Type.String()),
    clawDescription: Type.Optional(Type.String()),
    capabilityOffer: Type.Optional(Type.Array(Type.String())),
    domainInterests: Type.Optional(Type.Array(Type.String())),
    factTypePatterns: Type.Optional(Type.Array(Type.String())),
    priorityRange: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number()], {
        description: "Priority range [low, high] for subscription filter (0-7)",
      })
    ),
    modes: Type.Optional(
      Type.Array(Type.Union([Type.Literal("exclusive"), Type.Literal("broadcast")]))
    ),
    semanticKinds: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("observation"),
          Type.Literal("assertion"),
          Type.Literal("request"),
          Type.Literal("resolution"),
          Type.Literal("correction"),
          Type.Literal("signal"),
        ])
      )
    ),
    minEpistemicRank: Type.Optional(Type.Number({ default: -3 })),
    minConfidence: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 1 })),
    subjectKeyPatterns: Type.Optional(Type.Array(Type.String())),
    excludeSuperseded: Type.Optional(Type.Boolean({ default: true })),
    autoReconnect: Type.Optional(Type.Boolean({ default: true })),
    reconnectInterval: Type.Optional(Type.Number({ default: 5000 })),
    /** Enable auto-processing: spawn subagent when facts arrive */
    autoProcess: Type.Optional(Type.Boolean({ default: true })),
  }) as unknown as OpenClawPluginConfigSchema,

  register(api) {
    // Store runtime reference for subagent spawning
    pluginApi = api;

    const config = api.pluginConfig as unknown as FactBusPluginConfig & { autoProcess?: boolean };
    const logger = wrapPluginLogger(api.logger);

    // Initialize client
    client = new FactBusClient(config.busUrl);

    const toolContext: ToolContext = {
      client,
      logger,
    };

    // Register all tools (for manual use and subagent access)
    for (const tool of factBusTools) {
      api.registerTool(
        {
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (id, params) => {
            if (!client?.isConnected) {
              await connectToBus(config, logger);
            }
            ensureWebSocketAfterConnect(config, logger);
            return tool.execute(id, params, toolContext);
          },
        },
      );
    }

    // Register lifecycle hooks
    api.on("gateway_start", () => {
      toolContext.logger.info("Gateway starting; Fact Bus connect will run in background...");
      void (async () => {
        for (let attempt = 1; attempt <= STARTUP_CONNECT_MAX_ATTEMPTS; attempt++) {
          try {
            await connectToBus(config, toolContext.logger);
            ensureWebSocketAfterConnect(config, toolContext.logger, config.autoProcess ?? true);
            toolContext.logger.info("Fact Bus connected and WebSocket ensured.");
            return;
          } catch (error) {
            const delay = Math.min(
              STARTUP_CONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
              30_000
            );
            toolContext.logger.warn(
              `Fact Bus connect attempt ${attempt}/${STARTUP_CONNECT_MAX_ATTEMPTS} failed; retry in ${Math.round(delay)}ms: ${error instanceof Error ? error.message : String(error)}`
            );
            await sleep(delay);
          }
        }
        toolContext.logger.error(
          `Fact Bus: gave up after ${STARTUP_CONNECT_MAX_ATTEMPTS} connection attempts; tools will retry on use.`
        );
      })();
    });

    api.on("gateway_stop", () => {
      toolContext.logger.info("Gateway stopping, disconnecting from Fact Bus...");
      stopWebSocketService();
      client?.disconnect();
    });

    // Register background service for WebSocket
    api.registerService({
      id: "fact-bus-websocket",
      start: async () => {
        // Service is started via gateway_start hook
      },
      stop: async () => {
        stopWebSocketService();
      },
    });

    // Register HTTP route for health check
    api.registerHttpRoute({
      path: "/plugins/fact-bus/health",
      auth: "gateway",
      handler: async (_req, res) => {
        const health = {
          plugin: "fact-bus",
          connected: client?.isConnected ?? false,
          websocket: wsService?.isConnected ?? false,
          clawId: client?.currentClawId,
          websocketClawId: wsServiceClawId,
        };
        sendJson(res, health);
      },
    });
  },
});

// ============ Helper Functions ============

async function connectToBus(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
): Promise<void> {
  if (!client) {
    logger.error("Client not initialized");
    return;
  }

  if (client.isConnected) {
    logger.debug("Already connected to Fact Bus");
    return;
  }

  logger.info(`Connecting to Fact Bus at ${config.busUrl}...`);

  const response = await client.connect({
    name: config.clawName ?? "openclaw-agent",
    description: config.clawDescription ?? "OpenClaw Agent via Fact Bus Plugin",
    capability_offer: config.capabilityOffer ?? [],
    domain_interests: config.domainInterests ?? [],
    fact_type_patterns: config.factTypePatterns ?? [],
    priority_range: config.priorityRange ?? [0, 7],
    modes: config.modes ?? ["exclusive", "broadcast"],
    semantic_kinds: config.semanticKinds,
    min_epistemic_rank: config.minEpistemicRank,
    min_confidence: config.minConfidence,
    exclude_superseded: config.excludeSuperseded ?? true,
    subject_key_patterns: config.subjectKeyPatterns,
  });

  logger.info(`Connected to Fact Bus as claw: ${response.claw_id}`);
}

function ensureWebSocketAfterConnect(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"],
  autoProcess = true
): void {
  if (!client?.isConnected || !client.currentClawId) {
    return;
  }
  const cid = client.currentClawId;
  const needsRestart = !wsService || wsServiceClawId !== cid;
  if (!needsRestart) {
    return;
  }
  logger.info(
    `Fact Bus WebSocket: (re)starting for claw ${cid}${wsServiceClawId && wsServiceClawId !== cid ? ` (was ${wsServiceClawId})` : ""}`
  );
  stopWebSocketService();
  startWebSocketService(config, logger, autoProcess);
}

function startWebSocketService(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"],
  autoProcess = true
): void {
  if (!client || !client.isConnected || !client.currentClawId) {
    logger.warn("Cannot start WebSocket: client not connected");
    return;
  }

  wsServiceClawId = client.currentClawId;

  wsService = new FactBusWebSocketService({
    client,
    config,
    logger,
    onEvent: (event: BusEvent) => {
      handleWebSocketEvent(event, logger, config, autoProcess);
    },
  });

  void wsService.start();
  logger.info("WebSocket service started");
}

function stopWebSocketService(): void {
  if (wsService) {
    wsService.stop();
    wsService = null;
  }
  wsServiceClawId = null;
}

/**
 * Spawn a subagent to autonomously process a fact.
 * This mimics Channel behavior: event arrives → AI responds.
 */
async function spawnFactProcessor(
  fact: Fact,
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
): Promise<void> {
  if (!pluginApi?.runtime?.subagent?.run) {
    logger.warn("Cannot auto-process fact: subagent runtime not available");
    pushPendingEvent({ event_type: "fact_available", fact, timestamp: Date.now() });
    return;
  }

  const sessionKey = `fact-bus:fact:${fact.fact_id}`;
  const factJson = JSON.stringify(fact, null, 2);

  // Determine action based on fact mode and semantic kind
  const actionGuidance = getActionGuidance(fact);

  const prompt = `A new fact has arrived on the Claw Fact Bus that requires your attention.

## Fact Details

\`\`\`json
${factJson}
\`\`\`

## Your Configuration

- **clawName**: ${config.clawName ?? "openclaw-agent"}
- **capabilityOffer**: ${JSON.stringify(config.capabilityOffer ?? [])}
- **domainInterests**: ${JSON.stringify(config.domainInterests ?? [])}

## Action Required

${actionGuidance}

## Instructions

1. **If this is an EXCLUSIVE fact you can handle**: 
   - Call \\\`fact_bus_claim\\\` with fact_id "${fact.fact_id}"
   - If claim succeeds, process the task described in the payload
   - Call \\\`fact_bus_resolve\\\` with your results

2. **If this is a BROADCAST fact relevant to you**:
   - Process it immediately (no claim needed)
   - Optionally publish child facts using \\\`fact_bus_publish\\\`

3. **If you cannot handle this fact**:
   - Simply acknowledge and end the session

4. **After processing**:
   - Call \\\`fact_bus_sense\\\` to check for more pending facts

Start by claiming (if exclusive) or processing (if broadcast) the fact above.`;

  logger.info(`Spawning subagent for fact ${fact.fact_id} (${fact.fact_type})`);

  try {
    const { runId } = await pluginApi.runtime.subagent.run({
      sessionKey,
      message: prompt,
      deliver: false, // Don't deliver to user, run in background
    });

    logger.info(`Subagent spawned for fact ${fact.fact_id}, runId: ${runId}`);

    // Optionally wait for completion and log result
    // Note: We don't await here to avoid blocking the event handler
    void (async () => {
      try {
        await pluginApi!.runtime.subagent.waitForRun({ runId, timeoutMs: 300000 }); // 5 min timeout
        logger.info(`Subagent completed for fact ${fact.fact_id}`);
      } catch (err) {
        logger.warn(`Subagent timed out or failed for fact ${fact.fact_id}:`, err);
      }
    })();
  } catch (err) {
    logger.error(`Failed to spawn subagent for fact ${fact.fact_id}:`, err);
    // Fallback: push to pending queue for manual processing
    pushPendingEvent({ event_type: "fact_available", fact, timestamp: Date.now() });
  }
}

function getActionGuidance(fact: Fact): string {
  const { mode, semantic_kind, fact_type, payload } = fact;

  if (mode === "exclusive") {
    return `This is an **EXCLUSIVE** fact (mode: exclusive). 
Only one agent can process it. You should:
1. Check if the fact_type "${fact_type}" matches your capabilities
2. If yes, claim it immediately with fact_bus_claim
3. Process the payload: ${JSON.stringify(payload)}
4. Resolve with results using fact_bus_resolve`;
  }

  // Broadcast mode
  switch (semantic_kind) {
    case "request":
      return `This is a **REQUEST** (broadcast). Consider if you can fulfill this request.
If yes, you may claim it (if it becomes exclusive) or publish a helpful response fact.
Payload: ${JSON.stringify(payload)}`;
    case "observation":
      return `This is an **OBSERVATION** (broadcast). Acknowledge and react if relevant to your domain.
You may publish child facts if you have insights.
Payload: ${JSON.stringify(payload)}`;
    case "assertion":
      return `This is an **ASSERTION** (broadcast). You may validate it (corroborate/contradict) if you have evidence.
Payload: ${JSON.stringify(payload)}`;
    default:
      return `This is a **${semantic_kind?.toUpperCase() || "UNKNOWN"}** fact (broadcast).
Review and react appropriately. Payload: ${JSON.stringify(payload)}`;
  }
}

function handleWebSocketEvent(
  event: BusEvent,
  logger: ToolContext["logger"],
  config: FactBusPluginConfig,
  autoProcess = true
): void {
  const ev = event as unknown as {
    event_type: string;
    fact?: Fact;
    detail?: unknown;
  };

  const onOverflow = (dropped: number) => {
    logger.warn(
      `Fact Bus pending queue overflow: dropped ${dropped} oldest event(s); cap=${MAX_PENDING}. Use fact_bus_query if needed.`
    );
  };

  switch (ev.event_type) {
    case "fact_available": {
      const fact = event.fact;
      logger.info(`Fact available: ${fact?.fact_type} (mode: ${fact?.mode})`);

      if (autoProcess && fact && shouldAutoProcess(fact, config)) {
        // Spawn subagent to handle this fact immediately (Channel-like behavior)
        void spawnFactProcessor(fact, config, logger);
      } else {
        // Fallback: push to pending queue for manual fact_bus_sense
        pushPendingEvent(event, onOverflow);
      }
      break;
    }

    case "fact_claimed":
      logger.debug(`Fact claimed: ${ev.fact?.fact_id}`);
      pushPendingEvent(event, onOverflow);
      break;

    case "fact_resolved":
      logger.info(`Fact resolved: ${ev.fact?.fact_id}`);
      pushPendingEvent(event, onOverflow);
      break;

    case "fact_dead":
      logger.info(`Fact dead: ${ev.fact?.fact_id} ${ev.detail ?? ""}`);
      pushPendingEvent(event, onOverflow);
      break;

    case "fact_superseded":
      logger.info(`Fact superseded: ${event.fact?.fact_id}`);
      pushPendingEvent(event, onOverflow);
      break;

    case "fact_trust_changed":
      logger.debug(`Fact trust changed: ${event.fact?.fact_id}`, event.detail);
      pushPendingEvent(event, onOverflow);
      break;

    case "claw_state_changed":
      logger.debug(`Claw state changed`, ev.detail);
      pushPendingEvent(event, onOverflow);
      break;

    default:
      logger.debug(`WebSocket event: ${ev.event_type}`);
  }
}

/**
 * Determine if a fact should be auto-processed based on config filters.
 */
function shouldAutoProcess(fact: Fact, config: FactBusPluginConfig): boolean {
  // Check domain interests
  if (config.domainInterests && config.domainInterests.length > 0) {
    const hasDomainMatch = fact.domain_tags?.some((tag) =>
      config.domainInterests!.includes(tag)
    );
    if (!hasDomainMatch) return false;
  }

  // Check fact type patterns
  if (config.factTypePatterns && config.factTypePatterns.length > 0) {
    const matchesPattern = config.factTypePatterns.some((pattern) =>
      matchGlob(fact.fact_type, pattern)
    );
    if (!matchesPattern) return false;
  }

  // Check capability requirements
  if (fact.need_capabilities && fact.need_capabilities.length > 0) {
    const hasCapability = config.capabilityOffer?.some((cap) =>
      fact.need_capabilities!.includes(cap)
    );
    // If fact requires capabilities we don't have, don't auto-process
    if (!hasCapability && fact.mode === "exclusive") return false;
  }

  return true;
}

/**
 * Simple glob matching for fact type patterns.
 */
function matchGlob(value: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(value);
}
