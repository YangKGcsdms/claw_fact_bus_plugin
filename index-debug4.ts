import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginConfigSchema, PluginLogger } from "openclaw/plugin-sdk";
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
    debug: (...args: unknown[]) => { log.debug?.(join(args)); },
    info: (...args: unknown[]) => { log.info(join(args)); },
    warn: (...args: unknown[]) => { log.warn(join(args)); },
    error: (...args: unknown[]) => { log.error(join(args)); },
  };
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

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
    client = new FactBusClient(config.busUrl);
    const toolContext: ToolContext = {
      client,
      logger: {
        debug: (...args: unknown[]) => { logger.debug?.(args.map(String).join(" ")); },
        info: (...args: unknown[]) => { logger.info?.(args.map(String).join(" ")); },
        warn: (...args: unknown[]) => { logger.warn?.(args.map(String).join(" ")); },
        error: (...args: unknown[]) => { logger.error?.(args.map(String).join(" ")); },
      },
    };

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

    api.on("gateway_start", async () => {
      toolContext.logger.info("Gateway starting, connecting to Fact Bus...");
      await connectToBus(config, toolContext.logger);
    });

    api.on("gateway_stop", () => {
      toolContext.logger.info("Gateway stopping, disconnecting from Fact Bus...");
      client?.disconnect();
    });

    api.registerService({
      id: "fact-bus-websocket",
      start: async () => {},
      stop: async () => {},
    });

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

async function connectToBus(
  config: FactBusPluginConfig,
  logger: ToolContext["logger"]
): Promise<void> {
  if (!client) { return; }
  if (client.isConnected) { return; }
  await client.connect({
    name: config.clawName ?? "openclaw-agent",
    description: config.clawDescription ?? "OpenClaw Agent via Fact Bus Plugin",
    capability_offer: config.capabilityOffer ?? [],
    domain_interests: config.domainInterests ?? [],
    fact_type_patterns: config.factTypePatterns ?? [],
    priority_range: config.priorityRange ?? [0, 7],
    modes: config.modes ?? ["exclusive", "broadcast"],
  });
}

function startWebSocketService(config: FactBusPluginConfig, logger: ToolContext["logger"]): void {}
function setupWebSocketEventHandlers(service: FactBusWebSocketService, logger: ToolContext["logger"]): void {}
function stopWebSocketService(): void { if (wsService) { wsService.stop(); wsService = null; } }
function handleWebSocketEvent(event: BusEvent, logger: ToolContext["logger"]): void {
  pushPendingEvent(event);
}
