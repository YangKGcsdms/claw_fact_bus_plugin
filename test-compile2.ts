import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { factBusTools, type ToolContext } from "./src/tools.js";
import type { FactBusPluginConfig } from "./src/types.js";

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
          execute: async (id, params) => {
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
