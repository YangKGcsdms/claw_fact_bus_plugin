import { describe, it, expect, vi, beforeEach } from "vitest";
import { FactBusClient } from "../src/api.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("FactBusClient Extended", () => {
  let client: FactBusClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new FactBusClient("http://localhost:8080");
    // Mock connect response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ claw_id: "claw-123", token: "token-abc" }),
    });
    // Actually connect to set up state properly
    client.connect({ name: "test-claw" });
  });

  describe("claimFact", () => {
    it("should claim fact successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1", claimed_by: "claw-123" }),
      });

      const result = await client.claimFact("fact-1");
      expect(result.success).toBe(true);
      expect(result.data?.claimed_by).toBe("claw-123");
    });

    it("should fail when not connected", async () => {
      const disconnectedClient = new FactBusClient("http://localhost:8080");
      const result = await disconnectedClient.claimFact("fact-1");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Not connected to Fact Bus");
    });
  });

  describe("releaseFact", () => {
    it("should release fact successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1" }),
      });

      const result = await client.releaseFact("fact-1");
      expect(result.success).toBe(true);
    });
  });

  describe("resolveFact", () => {
    it("should resolve fact without result facts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1" }),
      });

      const result = await client.resolveFact("fact-1");
      expect(result.success).toBe(true);
    });

    it("should resolve fact with result facts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1" }),
      });

      const result = await client.resolveFact("fact-1", [
        { fact_type: "task.completed", payload: { task: "test" } },
      ]);
      expect(result.success).toBe(true);
    });
  });

  describe("corroborateFact", () => {
    it("should corroborate fact successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1", epistemic_state: "corroborated" }),
      });

      const result = await client.corroborateFact("fact-1");
      expect(result.success).toBe(true);
      expect(result.data?.epistemic_state).toBe("corroborated");
    });
  });

  describe("contradictFact", () => {
    it("should contradict fact successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, fact_id: "fact-1", epistemic_state: "contested" }),
      });

      const result = await client.contradictFact("fact-1");
      expect(result.success).toBe(true);
      expect(result.data?.epistemic_state).toBe("contested");
    });
  });

  describe("getFact", () => {
    it("should get fact by ID", async () => {
      const mockFact = { fact_id: "fact-1", fact_type: "test.type", state: "published" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFact),
      });

      const result = await client.getFact("fact-1");
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockFact);
    });
  });

  describe("listClaws", () => {
    it("should list claws", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ claw_id: "claw-1" }, { claw_id: "claw-2" }]),
      });

      const result = await client.listClaws();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });
  });

  describe("getStats", () => {
    it("should get stats", async () => {
      const mockStats = {
        facts: { total: 100, by_state: {}, by_epistemic: {} },
        claws: { total: 5, active: 3 },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStats),
      });

      const result = await client.getStats();
      expect(result.success).toBe(true);
      expect(result.data?.facts.total).toBe(100);
    });
  });

  describe("heartbeat", () => {
    it("should send heartbeat", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ claw_id: "claw-123", state: "active", timestamp: Date.now() }),
      });

      const result = await client.heartbeat();
      expect(result.success).toBe(true);
    });

    it("should fail when not connected", async () => {
      const disconnectedClient = new FactBusClient("http://localhost:8080");
      const result = await disconnectedClient.heartbeat();
      expect(result.success).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("should clear clawId and token", () => {
      expect(client.isConnected).toBe(true);
      client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(client.currentClawId).toBeNull();
      expect(client.currentToken).toBeNull();
    });
  });
});