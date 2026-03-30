declare const api: any;
declare const tools: any[];
for (const tool of tools) {
  api.registerTool(
    {
      name: tool.name,
      execute: async (id: any, params: any) => {
        return tool.execute(id, params);
      },
    }
  });
}
