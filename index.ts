/**
 * Claw Fact Bus OpenClaw Plugin Entry Point
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { FactBusClient } from "./src/api.js";
import { factBusTools, type ToolContext } from "./src/tools.js";
import { FactBusWebSocketService } from "./src/websocket.js";
import type { FactBusPluginConfig, BusEvent } from "./src/types.js";

// Plugin-level state
let client: FactBusClient | null = null;
let wsService: FactBusWebSocketService | null = null;

// Config schema with validation
const configSchema = {
  safeParse(value: unknown): { success: true; data: FactBusPluginConfig } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { success: false, error: { issues: [{ path: [], message: "config must be an object" }] } };
    }
    const cfg = value as Record<string, unknown>;
    if (typeof cfg.busUrl !== "string" || !cfg.busUrl) {
      return { success: false, error: { issues: [{ path: ["busUrl"], message: "busUrl is required" }] } };
    }
    // At this point we know busUrl exists and is a string
    const validConfig: FactBusPluginConfig = {
      busUrl: cfg.busUrl,
      clawName: cfg.clawName as string | undefined,
      clawDescription: cfg.clawDescription as string | undefined,
      capabilityOffer: cfg.capabilityOffer as string[] | undefined,
      domainInterests: cfg.domainInterests as string[] | undefined,
      factTypePatterns: cfg.factTypePatterns as string[] | undefined,
      priorityRange: cfg.priorityRange as [number, number] | undefined,
      modes: cfg.modes as ("broadcast" | "exclusive")[] | undefined,
      autoReconnect: cfg.autoReconnect as boolean | undefined,
      reconnectInterval: cfg.reconnectInterval as number | undefined,
    };
    return { success: true, data: validConfig };
  },

  parse(value: unknown): FactBusPluginConfig {
    const result = this.safeParse(value);
    if (!result.success) {
      throw new Error(result.error.issues.map(i => i.message).join(", "));
    }
    return result.data;
  },

  uiHints: {
    busUrl: {
      label: "Fact Bus URL",
      placeholder: "http://localhost:8080",
      help: "The URL of the Claw Fact Bus server",
    },
    clawName: {
      label: "Claw Name",
      help: "Unique identifier for this Claw agent",
    },
    clawDescription: {
      label: "Claw Description",
      help: "Description of this Claw's purpose",
    },
    capabilityOffer: {
      label: "Capabilities Offered",
      help: "List of capabilities this Claw can provide",
    },
    domainInterests: {
      label: "Domain Interests",
      help: "List of domains this Claw is interested in",
    },
    factTypePatterns: {
      label: "Fact Type Patterns",
      help: "Glob patterns for fact types to subscribe to",
    },
    autoReconnect: {
      label: "Auto Reconnect",
      help: "Automatically reconnect WebSocket on disconnect",
    },
    reconnectInterval: {
      label: "Reconnect Interval (ms)",
      help: "Interval between reconnection attempts",
      advanced: true,
    },
  },
};

export default definePluginEntry({
  id: "fact-bus",
  name: "Claw Fact Bus Plugin",
  description: "Integrates OpenClaw with Claw Fact Bus for fact-driven autonomous agent coordination",
  configSchema,

  register(api: OpenClawPluginApi) {
    const config = configSchema.parse(api.pluginConfig);
    const logger = api.logger;

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
      api.registerTool({
        name: tool.name,
        description: tool.description,
        label: tool.name,
        parameters: tool.parameters,
        execute: async (_id: string, params: unknown) => {
          // Ensure connected before tool execution
          if (!client?.isConnected) {
            await connectToBus(config, toolContext.logger);
          }
          const result = await tool.execute(_id, params as never, toolContext);
          return {
            content: result.content as never,
            details: {} as never,
          };
        },
      });
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
      auth: "plugin",
      handler: async (_req: unknown, res: unknown) => {
        const response = res as { json: (data: unknown) => void };
        const health = {
          plugin: "fact-bus",
          connected: client?.isConnected ?? false,
          websocket: wsService?.isConnected ?? false,
          clawId: client?.currentClawId,
        };
        response.json(health);
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
      logger.info(`Fact available: ${ev.fact?.fact_type}`);
      break;

    case "fact_claimed":
      logger.debug(`Fact claimed: ${ev.fact?.fact_id}`);
      break;

    case "fact_resolved":
      logger.info(`Fact resolved: ${ev.fact?.fact_id}`);
      break;

    case "fact_superseded":
      logger.info(`Fact superseded: ${ev.fact?.fact_id}`);
      break;

    case "fact_trust_changed":
      logger.debug(`Fact trust changed: ${ev.fact?.fact_id}`, ev.detail);
      break;

    case "claw_state_changed":
      logger.debug(`Claw state changed`, ev.detail);
      break;

    default:
      logger.debug(`WebSocket event: ${ev.event_type}`);
  }
}
