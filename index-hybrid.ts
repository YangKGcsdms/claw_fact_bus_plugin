/**
 * Claw Fact Bus OpenClaw Plugin Entry Point
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginConfigSchema,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { ServerResponse } from "node:http";
import { FactBusClient } from "./src/api.js";
import { factBusTools, type ToolContext } from "./src/tools.js";
import { FactBusWebSocketService } from "./src/websocket.js";
import { pushPendingEvent } from "./src/pending-events.js";
import type { FactBusPluginConfig, BusEvent } from "./src/types.js";

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
    autoReconnect: Type.Optional(Type.Boolean({ default: true })),
    reconnectInterval: Type.Optional(Type.Number({ default: 5000 })),
  }) as unknown as OpenClawPluginConfigSchema,

  register(api) {
    const config = api.pluginConfig as unknown as FactBusPluginConfig;
    const logger = wrapPluginLogger(api.logger);

    // Initialize client
    client = new FactBusClient(config.busUrl);

    // Create tool context with wrapped logger
    const toolContext: ToolContext = {
      client,
      logger: {
        debug: (...args: unknown[]) => { logger.debug?.(args.map(String).join(" ")); },
        info: (...args: unknown[]) => { logger.info?.(args.map(String).join(" ")); },
        warn: (...args: unknown[]) => { logger.warn?.(args.map(String).join(" ")); },
        error: (...args: unknown[]) => { logger.error?.(args.map(String).join(" ")); },
      },
    };

    // Register all tools

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
            return tool.execute(id, params, toolContext);
          },
        },
      );
    }

    // Register lifecycle hooks
    api.on("gateway_start", async () => {
      toolContext.logger.info("Gateway starting, connecting to Fact Bus...");
      await connectToBus(config, toolContext.logger);
      startWebSocketService(config, toolContext.logger);
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

  try {
    logger.info(`Connecting to Fact Bus at ${config.busUrl}...`);

    const response = await client.connect({
      name: config.clawName ?? "openclaw-agent",
      description: config.clawDescription ?? "OpenClaw Agent via Fact Bus Plugin",
      capability_offer: config.capabilityOffer ?? [],
      domain_interests: config.domainInterests ?? [],
      fact_type_patterns: config.factTypePatterns ?? [],
      priority_range: config.priorityRange ?? [0, 7],
      modes: config.modes ?? ["exclusive", "broadcast"],
    });

    logger.info(`Connected to Fact Bus as claw: ${response.claw_id}`);
  } catch (error) {
    logger.error("Failed to connect to Fact Bus:", error);
    throw error;
  }
}

function startWebSocketService(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
): void {
  if (!client || !client.isConnected) {
    logger.warn("Cannot start WebSocket: client not connected");
    return;
  }

  wsService = new FactBusWebSocketService({
    client,
    config,
    logger,
    onEvent: (event: BusEvent) => {
      handleWebSocketEvent(event, logger);
    },
  });

  // Set up typed event handlers
  setupWebSocketEventHandlers(wsService, logger);

  wsService.start();
  logger.info("WebSocket service started");
}

function setupWebSocketEventHandlers(
  service: FactBusWebSocketService,
  logger: ToolContext["logger"]
): void {
  // Handle fact_available events - new facts that match our subscription
  service.on("fact_available", ((event: { fact?: { fact_type?: string; fact_id?: string } }) => {
    logger.info(`New fact available: ${event.fact?.fact_type} (id: ${event.fact?.fact_id})`);
  }) as never);

  // Handle fact_claimed events
  service.on("fact_claimed", ((event: { fact?: { fact_id?: string; claimed_by?: string | null } }) => {
    logger.debug(`Fact claimed: ${event.fact?.fact_id} by ${event.fact?.claimed_by}`);
  }) as never);

  // Handle fact_resolved events
  service.on("fact_resolved", ((event: { fact?: { fact_id?: string } }) => {
    logger.info(`Fact resolved: ${event.fact?.fact_id}`);
  }) as never);

  // Handle fact_superseded events - knowledge evolution
  service.on("fact_superseded", ((event: { fact?: { fact_id?: string; superseded_by?: string } }) => {
    logger.info(`Fact superseded: ${event.fact?.fact_id} -> ${event.fact?.superseded_by}`);
  }) as never);

  // Handle fact_trust_changed events
  service.on("fact_trust_changed", ((event: { fact?: { fact_id?: string }; detail?: unknown }) => {
    logger.debug(`Fact trust changed: ${event.fact?.fact_id}`, event.detail);
  }) as never);

  // Handle claw_state_changed events
  service.on("claw_state_changed", ((event: { claw_id?: string; detail?: unknown }) => {
    logger.info(`Claw state changed: ${event.claw_id}`, event.detail);
  }) as never);

  // Handle fact_expired events
  service.on("fact_expired", ((event: { fact?: { fact_id?: string } }) => {
    logger.debug(`Fact expired: ${event.fact?.fact_id}`);
  }) as never);

  // Handle fact_dead events
  service.on("fact_dead", ((event: { fact?: { fact_id?: string } }) => {
    logger.debug(`Fact dead: ${event.fact?.fact_id}`);
  }) as never);
}

function stopWebSocketService(): void {
  if (wsService) {
    wsService.stop();
    wsService = null;
  }
}

function handleWebSocketEvent(
  event: BusEvent,
  logger: ToolContext["logger"]
): void {
  const ev = event as unknown as { event_type: string; fact?: { fact_id?: string; fact_type?: string }; detail?: unknown };
  switch (ev.event_type) {
    case "fact_available":
      logger.info(`Fact available: ${event.fact?.fact_type}`);
      pushPendingEvent(event);
      break;

    case "fact_claimed":
      logger.debug(`Fact claimed: ${ev.fact?.fact_id}`);
      break;

    case "fact_resolved":
      logger.info(`Fact resolved: ${ev.fact?.fact_id}`);
      break;

    case "fact_superseded":
      logger.info(`Fact superseded: ${event.fact?.fact_id}`);
      pushPendingEvent(event);
      break;

    case "fact_trust_changed":
      logger.debug(`Fact trust changed: ${event.fact?.fact_id}`, event.detail);
      pushPendingEvent(event);
      break;

    case "claw_state_changed":
      logger.debug(`Claw state changed`, ev.detail);
      break;

    default:
      logger.debug(`WebSocket event: ${ev.event_type}`);
  }
}
