/**
 * Claw Fact Bus OpenClaw Plugin Entry Point
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { FactBusClient } from "./src/api.js";
import { factBusTools, type ToolContext } from "./src/tools.js";
import { FactBusWebSocketService } from "./src/websocket.js";
import type { FactBusPluginConfig, BusEvent } from "./src/types.js";

// Plugin-level state
let client: FactBusClient | null = null;
let wsService: FactBusWebSocketService | null = null;

export default definePluginEntry({
  id: "fact-bus",
  name: "Claw Fact Bus Plugin",
  description:
    "Integrates OpenClaw with Claw Fact Bus for fact-driven autonomous agent coordination",

  configSchema: Type.Object({
    busUrl: Type.String({ default: "http://localhost:8080" }),
    clawName: Type.Optional(Type.String()),
    clawDescription: Type.Optional(Type.String()),
    capabilityOffer: Type.Optional(Type.Array(Type.String())),
    domainInterests: Type.Optional(Type.Array(Type.String())),
    factTypePatterns: Type.Optional(Type.Array(Type.String())),
    autoReconnect: Type.Optional(Type.Boolean({ default: true })),
    reconnectInterval: Type.Optional(Type.Number({ default: 5000 })),
  }),

  register(api) {
    const config = api.pluginConfig as FactBusPluginConfig;
    const logger = api.logger;

    // Initialize client
    client = new FactBusClient(config.busUrl);

    // Create tool context
    const toolContext: ToolContext = {
      client,
      logger,
    };

    // Register all tools
    for (const tool of factBusTools) {
      api.registerTool(
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (id, params) => {
            // Ensure connected before tool execution
            if (!client?.isConnected) {
              await connectToBus(config, logger);
            }
            return tool.execute(id, params, toolContext);
          },
        },
        { optional: false }
      );
    }

    // Register lifecycle hooks
    api.on("gateway_start", async () => {
      logger.info("Gateway starting, connecting to Fact Bus...");
      await connectToBus(config, logger);
      startWebSocketService(config, logger);
    });

    api.on("gateway_stop", () => {
      logger.info("Gateway stopping, disconnecting from Fact Bus...");
      stopWebSocketService();
      client?.disconnect();
    });

    // Register background service for WebSocket
    api.registerService({
      id: "fact-bus-websocket",
      name: "Fact Bus WebSocket Service",
      start: async () => {
        // Service is started via gateway_start hook
      },
      stop: async () => {
        stopWebSocketService();
      },
    });

    // Register HTTP route for health check
    api.registerHttpRoute({
      method: "GET",
      path: "/plugins/fact-bus/health",
      handler: async (_req, res) => {
        const health = {
          plugin: "fact-bus",
          connected: client?.isConnected ?? false,
          websocket: wsService?.isConnected ?? false,
          clawId: client?.currentClawId,
        };
        res.json(health);
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

  wsService.start();
  logger.info("WebSocket service started");
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
  switch (event.event_type) {
    case "fact_available":
      logger.info(`Fact available: ${event.fact?.fact_type}`);
      // Could trigger agent processing here
      break;

    case "fact_claimed":
      logger.debug(`Fact claimed: ${event.fact?.fact_id}`);
      break;

    case "fact_resolved":
      logger.info(`Fact resolved: ${event.fact?.fact_id}`);
      break;

    case "fact_superseded":
      logger.info(`Fact superseded: ${event.fact?.fact_id}`);
      break;

    case "fact_trust_changed":
      logger.debug(`Fact trust changed: ${event.fact?.fact_id}`, event.detail);
      break;

    case "claw_state_changed":
      logger.debug(`Claw state changed`, event.detail);
      break;

    default:
      logger.debug(`WebSocket event: ${event.event_type}`);
  }
}
