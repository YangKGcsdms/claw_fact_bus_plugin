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
import { MAX_PENDING, pushPendingEvent } from "./src/pending-events.js";
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
/** claw_id the current WebSocket subscription was opened for (if any). */
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
    autoReconnect: Type.Optional(Type.Boolean({ default: true })),
    reconnectInterval: Type.Optional(Type.Number({ default: 5000 })),
  }) as unknown as OpenClawPluginConfigSchema,

  register(api) {
    const config = api.pluginConfig as unknown as FactBusPluginConfig;
    const logger = wrapPluginLogger(api.logger);

    // Initialize client
    client = new FactBusClient(config.busUrl);

    const toolContext: ToolContext = {
      client,
      logger,
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
            // Ensure connected before tool execution
            if (!client?.isConnected) {
              await connectToBus(config, logger);
            }
            ensureWebSocketAfterConnect(config, logger);
            return tool.execute(id, params, toolContext);
          },
        },
      );
    }

    // Register lifecycle hooks — connect in background so gateway is not blocked if bus starts late
    api.on("gateway_start", () => {
      toolContext.logger.info("Gateway starting; Fact Bus connect will run in background...");
      void (async () => {
        for (let attempt = 1; attempt <= STARTUP_CONNECT_MAX_ATTEMPTS; attempt++) {
          try {
            await connectToBus(config, toolContext.logger);
            ensureWebSocketAfterConnect(config, toolContext.logger);
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
  });

  logger.info(`Connected to Fact Bus as claw: ${response.claw_id}`);
}

/**
 * (Re)start WebSocket when HTTP session is new or claw_id changed, or WS is down.
 */
function ensureWebSocketAfterConnect(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
): void {
  if (!client?.isConnected || !client.currentClawId) {
    return;
  }
  const cid = client.currentClawId;
  // Only restart when there is no WS service or the HTTP session claw_id changed.
  // Do not key off isConnected — the WebSocket layer handles reconnect/backoff itself.
  const needsRestart = !wsService || wsServiceClawId !== cid;
  if (!needsRestart) {
    return;
  }
  logger.info(
    `Fact Bus WebSocket: (re)starting for claw ${cid}${wsServiceClawId && wsServiceClawId !== cid ? ` (was ${wsServiceClawId})` : ""}`
  );
  stopWebSocketService();
  startWebSocketService(config, logger);
}

function startWebSocketService(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
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
      handleWebSocketEvent(event, logger);
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

function handleWebSocketEvent(
  event: BusEvent,
  logger: ToolContext["logger"]
): void {
  const ev = event as unknown as {
    event_type: string;
    fact?: { fact_id?: string; fact_type?: string };
    detail?: unknown;
  };
  const onOverflow = (dropped: number) => {
    logger.warn(
      `Fact Bus pending queue overflow: dropped ${dropped} oldest event(s); cap=${MAX_PENDING}. Use fact_bus_query if needed.`
    );
  };

  switch (ev.event_type) {
    case "fact_available":
      logger.info(`Fact available: ${event.fact?.fact_type}`);
      pushPendingEvent(event, onOverflow);
      break;

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
      break;

    default:
      logger.debug(`WebSocket event: ${ev.event_type}`);
  }
}
