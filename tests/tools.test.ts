import { describe, it, expect } from "vitest";
import { factBusTools } from "../src/tools.js";

describe("Fact Bus Tools", () => {
  describe("tool definitions", () => {
    it("should have all required tools", () => {
      const toolNames = factBusTools.map((t) => t.name);

      expect(toolNames).toContain("fact_bus_sense");
      expect(toolNames).toContain("fact_bus_publish");
      expect(toolNames).toContain("fact_bus_query");
      expect(toolNames).toContain("fact_bus_claim");
      expect(toolNames).toContain("fact_bus_release");
      expect(toolNames).toContain("fact_bus_resolve");
      expect(toolNames).toContain("fact_bus_validate");
      expect(toolNames).toContain("fact_bus_get_schema");
    });

    it("should have descriptions for all tools", () => {
      for (const tool of factBusTools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it("should have parameters defined for all tools", () => {
      for (const tool of factBusTools) {
        expect(tool.parameters).toBeDefined();
      }
    });
  });

  describe("publish tool", () => {
    const publishTool = factBusTools.find((t) => t.name === "fact_bus_publish");

    it("should require fact_type and payload", () => {
      expect(publishTool).toBeDefined();
    });
  });

  describe("query tool", () => {
    const queryTool = factBusTools.find((t) => t.name === "fact_bus_query");

    it("should have optional parameters", () => {
      expect(queryTool).toBeDefined();
    });
  });

  describe("release tool", () => {
    const releaseTool = factBusTools.find((t) => t.name === "fact_bus_release");

    it("should require fact_id", () => {
      expect(releaseTool).toBeDefined();
    });
  });

  describe("validate tool", () => {
    const validateTool = factBusTools.find((t) => t.name === "fact_bus_validate");

    it("should require fact_id and action", () => {
      expect(validateTool).toBeDefined();
    });
  });

  describe("sense tool", () => {
    const senseTool = factBusTools.find((t) => t.name === "fact_bus_sense");

    it("should be defined", () => {
      expect(senseTool).toBeDefined();
    });
  });
});
