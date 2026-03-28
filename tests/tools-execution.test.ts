import { describe, it, expect, vi, beforeEach } from "vitest";
import { factBusTools } from "../src/tools.js";
import type { FactBusClient } from "../src/api.js";

// Mock client
const createMockClient = (connected = true) => ({
  isConnected: connected,
  currentClawId: connected ? "claw-123" : null,
  currentToken: connected ? "token-abc" : null,
  publishFact: vi.fn(),
  queryFacts: vi.fn(),
  claimFact: vi.fn(),
  resolveFact: vi.fn(),
  corroborateFact: vi.fn(),
  contradictFact: vi.fn(),
});

// Mock logger
const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("Fact Bus Tools Execution", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let context: { client: typeof mockClient; logger: typeof mockLogger };

  beforeEach(() => {
    mockClient = createMockClient(true);
    mockLogger = createMockLogger();
    context = { client: mockClient, logger: mockLogger };
  });

  describe("fact_bus_publish", () => {
    const tool = factBusTools.find((t) => t.name === "fact_bus_publish")!;

    it("should publish fact successfully", async () => {
      mockClient.publishFact = vi.fn().mockResolvedValue({
        success: true,
        data: {
          fact_id: "fact-new-123",
          fact_type: "test.type",
          state: "published",
          created_at: Date.now(),
        },
      });

      const result = await tool.execute("1", {
        fact_type: "test.type",
        payload: { key: "value" },
      }, context);

      expect(mockClient.publishFact).toHaveBeenCalledWith({
        fact_type: "test.type",
        payload: { key: "value" },
        semantic_kind: undefined,
        priority: undefined,
        mode: undefined,
        subject_key: undefined,
        confidence: undefined,
        ttl_seconds: undefined,
        domain_tags: undefined,
        need_capabilities: undefined,
        causation_chain: undefined,
        causation_depth: undefined,
      });
      expect(result.content[0].text).toContain("fact-new-123");
    });

    it("should handle not connected error", async () => {
      const disconnectedClient = createMockClient(false);
      const disconnectedContext = { client: disconnectedClient, logger: mockLogger };

      const result = await tool.execute("1", {
        fact_type: "test.type",
        payload: {},
      }, disconnectedContext);

      expect(result.content[0].text).toContain("Not connected");
    });

    it("should handle publish failure", async () => {
      mockClient.publishFact = vi.fn().mockResolvedValue({
        success: false,
        error: "Failed to publish",
      });

      const result = await tool.execute("1", {
        fact_type: "test.type",
        payload: {},
      }, context);

      expect(result.content[0].text).toContain("Failed to publish");
    });
  });

  describe("fact_bus_query", () => {
    const tool = factBusTools.find((t) => t.name === "fact_bus_query")!;

    it("should query facts successfully", async () => {
      mockClient.queryFacts = vi.fn().mockResolvedValue({
        success: true,
        data: [
          { fact_id: "fact-1", fact_type: "test.1", state: "published", confidence: 1.0, created_at: Date.now(), subject_key: "" },
          { fact_id: "fact-2", fact_type: "test.2", state: "resolved", confidence: 0.9, created_at: Date.now(), subject_key: "" },
        ],
      });

      const result = await tool.execute("1", {
        fact_type: "test.*",
        limit: 10,
      }, context);

      expect(mockClient.queryFacts).toHaveBeenCalledWith({
        fact_type: "test.*",
        state: undefined,
        source_claw_id: undefined,
        limit: 10,
      });
      expect(result.content[0].text).toContain('"count": 2');
    });

    it("should handle query failure", async () => {
      mockClient.queryFacts = vi.fn().mockResolvedValue({
        success: false,
        error: "Query failed",
      });

      const result = await tool.execute("1", {}, context);

      expect(result.content[0].text).toContain("Query failed");
    });
  });

  describe("fact_bus_claim", () => {
    const tool = factBusTools.find((t) => t.name === "fact_bus_claim")!;

    it("should claim fact successfully", async () => {
      mockClient.claimFact = vi.fn().mockResolvedValue({
        success: true,
        data: { success: true, fact_id: "fact-1", claimed_by: "claw-123" },
      });

      const result = await tool.execute("1", { fact_id: "fact-1" }, context);

      expect(mockClient.claimFact).toHaveBeenCalledWith("fact-1");
      expect(result.content[0].text).toContain("claw-123");
    });

    it("should handle not connected", async () => {
      const disconnectedClient = createMockClient(false);
      const result = await tool.execute("1", { fact_id: "fact-1" }, { client: disconnectedClient, logger: mockLogger });

      expect(result.content[0].text).toContain("Not connected");
    });
  });

  describe("fact_bus_resolve", () => {
    const tool = factBusTools.find((t) => t.name === "fact_bus_resolve")!;

    it("should resolve fact successfully", async () => {
      mockClient.resolveFact = vi.fn().mockResolvedValue({
        success: true,
        data: { success: true, fact_id: "fact-1" },
      });

      const result = await tool.execute("1", { fact_id: "fact-1" }, context);

      expect(mockClient.resolveFact).toHaveBeenCalledWith("fact-1", undefined);
      expect(result.content[0].text).toContain("fact-1");
    });

    it("should resolve with result facts", async () => {
      mockClient.resolveFact = vi.fn().mockResolvedValue({
        success: true,
        data: { success: true, fact_id: "fact-1" },
      });

      const result = await tool.execute("1", {
        fact_id: "fact-1",
        result_facts: [{ fact_type: "task.done", payload: { done: true } }],
      }, context);

      expect(mockClient.resolveFact).toHaveBeenCalledWith("fact-1", [
        { fact_type: "task.done", payload: { done: true } },
      ]);
    });
  });

  describe("fact_bus_validate", () => {
    const tool = factBusTools.find((t) => t.name === "fact_bus_validate")!;

    it("should corroborate fact", async () => {
      mockClient.corroborateFact = vi.fn().mockResolvedValue({
        success: true,
        data: { success: true, fact_id: "fact-1", epistemic_state: "corroborated" },
      });

      const result = await tool.execute("1", { fact_id: "fact-1", action: "corroborate" }, context);

      expect(mockClient.corroborateFact).toHaveBeenCalledWith("fact-1");
      expect(result.content[0].text).toContain("corroborated");
    });

    it("should contradict fact", async () => {
      mockClient.contradictFact = vi.fn().mockResolvedValue({
        success: true,
        data: { success: true, fact_id: "fact-1", epistemic_state: "contested" },
      });

      const result = await tool.execute("1", { fact_id: "fact-1", action: "contradict" }, context);

      expect(mockClient.contradictFact).toHaveBeenCalledWith("fact-1");
      expect(result.content[0].text).toContain("contested");
    });

    it("should handle not connected", async () => {
      const disconnectedClient = createMockClient(false);
      const result = await tool.execute("1", { fact_id: "fact-1", action: "corroborate" }, { client: disconnectedClient, logger: mockLogger });

      expect(result.content[0].text).toContain("Not connected");
    });
  });
});