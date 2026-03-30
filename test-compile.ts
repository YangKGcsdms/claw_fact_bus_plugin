import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginConfigSchema, PluginLogger } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { ServerResponse } from "node:http";
import { FactBusClient } from "./src/api.js";
import { factBusTools, type ToolContext } from "./src/tools.js";
import { FactBusWebSocketService } from "./src/websocket.js";
import { pushPendingEvent } from "./src/pending-events.js";
import type { FactBusPluginConfig, BusEvent } from "./src/types.js";

export default definePluginEntry({
  id: "test",
  name: "Test",
  description: "Test",
  configSchema: Type.Object({}) as unknown as OpenClawPluginConfigSchema,
  register(api) {
    const client: any = null;
    const config = api.pluginConfig as unknown as FactBusPluginConfig;
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const toolContext: ToolContext = { client, logger };
    const connectToBus = async (c: any, l: any) => {};

    for (const tool of factBusTools) {
      api.registerTool(
        {
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (id: any, params: any) => {
            if (!client?.isConnected) {
              await connectToBus(config, logger);
            }
            return tool.execute(id, params, toolContext);
          },
        },
      );
    }
  },
});
