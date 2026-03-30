import { describe, it, expect, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import manifest from "../openclaw.plugin.json";

// Mock the openclaw module
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: vi.fn((config) => config),
}));

// We need to mock the dependencies that index.ts imports
vi.mock("../src/api.js", () => ({
  FactBusClient: vi.fn().mockImplementation(() => ({
    isConnected: false,
    connect: vi.fn().mockResolvedValue({ claw_id: "test-claw", token: "test-token" }),
    disconnect: vi.fn(),
    currentClawId: null,
    currentToken: null,
    getWebSocketUrl: () => "ws://localhost:8080",
    publishFact: vi.fn(),
    queryFacts: vi.fn(),
    claimFact: vi.fn(),
    resolveFact: vi.fn(),
    corroborateFact: vi.fn(),
    contradictFact: vi.fn(),
  })),
}));

vi.mock("../src/websocket.js", () => ({
  FactBusWebSocketService: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    get isConnected() {
      return false;
    },
    on: vi.fn(() => () => {}),
    onAll: vi.fn(() => () => {}),
    stats: { connectionAttempts: 0, lastConnectedAt: null, isConnected: false },
    connectionState: "disconnected",
  })),
}));

describe("Plugin Entry", () => {
  describe("config schema", () => {
    it("should have a TypeBox config schema", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      // Check that the plugin has configSchema (TypeBox schema)
      expect(defaultExport).toHaveProperty("configSchema");
      expect(defaultExport.configSchema).toHaveProperty("type");
      expect(defaultExport.configSchema.type).toBe("object");
    });

    it("should have busUrl as required field", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      // TypeBox schema should have busUrl in required properties
      expect(defaultExport.configSchema.required).toContain("busUrl");
    });

    it("should have correct config structure", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      const props = defaultExport.configSchema.properties;
      expect(props).toHaveProperty("busUrl");
      expect(props).toHaveProperty("clawName");
      expect(props).toHaveProperty("clawDescription");
      expect(props).toHaveProperty("autoReconnect");
      expect(props).toHaveProperty("reconnectInterval");
    });

    it("should validate config with busUrl via TypeBox Value", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;
      const schema = defaultExport.configSchema;

      const ok = Value.Check(schema, {
        busUrl: "http://localhost:8080",
        clawName: "test-claw",
      });
      expect(ok).toBe(true);
    });

    it("should reject invalid config types", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;
      const schema = defaultExport.configSchema;

      expect(Value.Check(schema, null)).toBe(false);
      expect(Value.Check(schema, "string")).toBe(false);
      expect(Value.Check(schema, [1, 2, 3])).toBe(false);
    });
  });

  describe("plugin metadata", () => {
    it("should have correct plugin id", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      expect(defaultExport.id).toBe("fact-bus");
    });

    it("should have correct plugin name", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      expect(defaultExport.name).toBe("Claw Fact Bus Plugin");
    });

    it("should have description", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      expect(defaultExport.description).toBeTruthy();
      expect(defaultExport.description.length).toBeGreaterThan(10);
    });
  });

  describe("register callback", () => {
    it("should be defined", async () => {
      const pluginModule = await import("../index.js");
      const defaultExport = pluginModule.default;

      expect(typeof defaultExport.register).toBe("function");
    });
  });
});

describe("Config Schema Properties", () => {
  it("should have optional properties correctly defined", async () => {
    const pluginModule = await import("../index.js");
    const defaultExport = pluginModule.default;

    const props = defaultExport.configSchema.properties;
    // Optional properties should not be in required array
    expect(defaultExport.configSchema.required).not.toContain("clawName");
    expect(defaultExport.configSchema.required).not.toContain("autoReconnect");
    
    // But should exist in properties
    expect(props).toHaveProperty("clawName");
    expect(props).toHaveProperty("autoReconnect");
    expect(props).toHaveProperty("reconnectInterval");
  });
});

describe("Config UI Hints", () => {
  it("should have uiHints for key options in openclaw.plugin.json", () => {
    const { uiHints } = manifest;
    expect(uiHints).toBeDefined();
    expect(uiHints.busUrl).toHaveProperty("label");
    expect(uiHints.clawName).toHaveProperty("label");
    expect(uiHints.clawDescription).toHaveProperty("label");
    expect(uiHints.capabilityOffer).toHaveProperty("label");
    expect(uiHints.domainInterests).toHaveProperty("label");
    expect(uiHints.factTypePatterns).toHaveProperty("label");
    expect(uiHints.semanticKinds).toHaveProperty("label");
    expect(uiHints.subjectKeyPatterns).toHaveProperty("label");
  });
});
