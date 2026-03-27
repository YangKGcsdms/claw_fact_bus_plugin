import { describe, it, expect, vi, beforeEach } from "vitest";
import { FactBusClient } from "../src/api.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("FactBusClient", () => {
  let client: FactBusClient;

  beforeEach(() => {
    client = new FactBusClient("http://localhost:8080");
    mockFetch.mockReset();
  });

  describe("constructor", () => {
    it("should normalize URL by removing trailing slash", () => {
      const clientWithSlash = new FactBusClient("http://localhost:8080/");
      expect(clientWithSlash["baseUrl"]).toBe("http://localhost:8080");
    });
  });

  describe("connect", () => {
    it("should connect and store claw_id and token", async () => {
      const mockResponse = {
        claw_id: "test-claw-123",
        token: "test-token-456",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.connect({
        name: "test-claw",
        description: "Test claw",
      });

      expect(result).toEqual(mockResponse);
      expect(client.currentClawId).toBe("test-claw-123");
      expect(client.currentToken).toBe("test-token-456");
      expect(client.isConnected).toBe(true);
    });

    it("should handle connection failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await expect(
        client.connect({ name: "test-claw" })
      ).rejects.toThrow();
    });
  });

  describe("publishFact", () => {
    it("should fail if not connected", async () => {
      const result = await client.publishFact({
        fact_type: "test.fact",
        payload: { test: true },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Not connected to Fact Bus");
    });

    it("should publish fact when connected", async () => {
      // First connect
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ claw_id: "claw-1", token: "token-1" }),
      });
      await client.connect({ name: "test" });

      // Then publish
      const mockFact = {
        fact_id: "fact-123",
        fact_type: "test.fact",
        payload: { test: true },
        state: "published",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFact),
      });

      const result = await client.publishFact({
        fact_type: "test.fact",
        payload: { test: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockFact);
    });
  });

  describe("queryFacts", () => {
    it("should query facts with parameters", async () => {
      const mockFacts = [
        { fact_id: "fact-1", fact_type: "test.1" },
        { fact_id: "fact-2", fact_type: "test.2" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFacts),
      });

      const result = await client.queryFacts({
        fact_type: "test.*",
        limit: 10,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockFacts);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("fact_type=test.*"),
        expect.any(Object)
      );
    });
  });

  describe("healthCheck", () => {
    it("should return true for healthy server", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    it("should return false for unhealthy server", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
      const result = await client.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe("getWebSocketUrl", () => {
    it("should convert http to ws", () => {
      const wsUrl = client.getWebSocketUrl();
      expect(wsUrl).toBe("ws://localhost:8080");
    });

    it("should convert https to wss", () => {
      const httpsClient = new FactBusClient("https://example.com");
      const wsUrl = httpsClient.getWebSocketUrl();
      expect(wsUrl).toBe("wss://example.com");
    });
  });
});
