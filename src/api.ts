/**
 * Claw Fact Bus API Client
 * HTTP client for interacting with the Fact Bus server
 * Matches the FastAPI endpoints in claw_fact_bus/server/app.py
 */

import type {
  Fact,
  FactCreateRequest,
  QueryFactsParams,
  ClawConnectRequest,
  ClawResponse,
  StatsResponse,
  ApiResponse,
  ClaimRequest,
  ResolveRequest,
  CorroborateRequest,
  ContradictRequest,
  SchemaInfo,
  SchemaValidationResult,
  ActivityLogEntry,
} from "./types.js";

export class FactBusClient {
  private baseUrl: string;
  private clawId: string | null = null;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ============ Connection Management ============

  async connect(request: ClawConnectRequest): Promise<ClawResponse> {
    const response = await this.fetchJson<ClawResponse>("/claws/connect", {
      method: "POST",
      body: JSON.stringify({
        name: request.name,
        description: request.description || "",
        capability_offer: request.capability_offer || [],
        domain_interests: request.domain_interests || [],
        fact_type_patterns: request.fact_type_patterns || [],
        priority_range: request.priority_range || [0, 7],
        modes: request.modes || ["exclusive", "broadcast"],
        max_concurrent_claims: request.max_concurrent_claims || 1,
      }),
    });

    if (response.success && response.data) {
      this.clawId = response.data.claw_id;
      this.token = response.data.token || null;
    } else {
      throw new Error(response.error || "Failed to connect to Fact Bus");
    }

    return response.data!;
  }

  async heartbeat(): Promise<ApiResponse<{ claw_id: string; state: string; timestamp: number }>> {
    if (!this.clawId) {
      return { success: false, error: "Not connected" };
    }

    return this.fetchJson(`/claws/${this.clawId}/heartbeat`, {
      method: "POST",
    });
  }

  disconnect(): void {
    this.clawId = null;
    this.token = null;
  }

  get isConnected(): boolean {
    return this.clawId !== null;
  }

  get currentClawId(): string | null {
    return this.clawId;
  }

  get currentToken(): string | null {
    return this.token;
  }

  // ============ Fact Operations ============

  async publishFact(request: FactCreateRequest): Promise<ApiResponse<Fact>> {
    if (!this.clawId || !this.token) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: FactCreateRequest = {
      fact_type: request.fact_type,
      semantic_kind: request.semantic_kind || "observation",
      payload: request.payload || {},
      domain_tags: request.domain_tags || [],
      need_capabilities: request.need_capabilities || [],
      priority: request.priority ?? 3,
      mode: request.mode || "exclusive",
      source_claw_id: this.clawId,
      token: this.token,
      ttl_seconds: request.ttl_seconds || 300,
      schema_version: request.schema_version || "1.0.0",
      confidence: request.confidence ?? 1.0,
      causation_chain: request.causation_chain || [],
      causation_depth: request.causation_depth || 0,
      subject_key: request.subject_key || "",
      supersedes: request.supersedes || "",
    };

    return this.fetchJson<Fact>("/facts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async queryFacts(params: QueryFactsParams = {}): Promise<ApiResponse<Fact[]>> {
    const searchParams = new URLSearchParams();

    if (params.fact_type) searchParams.set("fact_type", params.fact_type);
    if (params.state) searchParams.set("state", params.state);
    if (params.source_claw_id) searchParams.set("source_claw_id", params.source_claw_id);
    if (params.limit) searchParams.set("limit", String(params.limit));

    const query = searchParams.toString();
    const path = query ? `/facts?${query}` : "/facts";

    return this.fetchJson<Fact[]>(path, {
      method: "GET",
    });
  }

  async getFact(factId: string): Promise<ApiResponse<Fact>> {
    return this.fetchJson<Fact>(`/facts/${factId}`, {
      method: "GET",
    });
  }

  async claimFact(factId: string): Promise<ApiResponse<{ success: boolean; fact_id: string; claimed_by: string }>> {
    if (!this.clawId || !this.token) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: ClaimRequest = {
      claw_id: this.clawId,
      token: this.token,
    };

    return this.fetchJson(`/facts/${factId}/claim`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async releaseFact(factId: string): Promise<ApiResponse<{ success: boolean; fact_id: string }>> {
    if (!this.clawId || !this.token) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: ClaimRequest = {
      claw_id: this.clawId,
      token: this.token,
    };

    return this.fetchJson(`/facts/${factId}/release`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async resolveFact(
    factId: string,
    resultFacts?: ResolveRequest["result_facts"]
  ): Promise<ApiResponse<{ success: boolean; fact_id: string }>> {
    if (!this.clawId || !this.token) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: ResolveRequest = {
      claw_id: this.clawId,
      token: this.token,
      result_facts: resultFacts || [],
    };

    return this.fetchJson(`/facts/${factId}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async corroborateFact(factId: string): Promise<ApiResponse<{ success: boolean; fact_id: string; epistemic_state: string }>> {
    if (!this.clawId) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: CorroborateRequest = {
      claw_id: this.clawId,
    };

    return this.fetchJson(`/facts/${factId}/corroborate`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async contradictFact(factId: string): Promise<ApiResponse<{ success: boolean; fact_id: string; epistemic_state: string }>> {
    if (!this.clawId) {
      return { success: false, error: "Not connected to Fact Bus" };
    }

    const body: ContradictRequest = {
      claw_id: this.clawId,
    };

    return this.fetchJson(`/facts/${factId}/contradict`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ============ Utility Methods ============

  async listClaws(): Promise<ApiResponse<unknown[]>> {
    return this.fetchJson<unknown[]>("/claws", {
      method: "GET",
    });
  }

  async getClawActivity(clawId: string, limit = 50): Promise<ApiResponse<{ claw_id: string; activity: ActivityLogEntry[] }>> {
    return this.fetchJson<{ claw_id: string; activity: ActivityLogEntry[] }>(`/claws/${clawId}/activity?limit=${limit}`, {
      method: "GET",
    });
  }

  async getStats(): Promise<ApiResponse<StatsResponse>> {
    return this.fetchJson<StatsResponse>("/stats", {
      method: "GET",
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getWebSocketUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Remove trailing slash for consistency
    const urlStr = url.toString();
    return urlStr.endsWith("/") ? urlStr.slice(0, -1) : urlStr;
  }

  // ============ Schema Registry Methods ============

  async listSchemas(): Promise<ApiResponse<Record<string, string[]>>> {
    return this.fetchJson<Record<string, string[]>>("/schemas", {
      method: "GET",
    });
  }

  async getSchema(factType: string, version?: string): Promise<ApiResponse<SchemaInfo>> {
    const query = version ? `?version=${version}` : "";
    return this.fetchJson<SchemaInfo>(`/schemas/${factType}${query}`, {
      method: "GET",
    });
  }

  async validateSchema(factType: string, payload: Record<string, unknown>, version?: string): Promise<ApiResponse<SchemaValidationResult>> {
    const query = version ? `?version=${version}` : "";
    return this.fetchJson<SchemaValidationResult>(`/schemas/${factType}/validate${query}`, {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
  }

  // ============ Private Helpers ============

  private async fetchJson<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        return {
          success: false,
          error: (errorData.error as string) || `HTTP ${response.status}`,
        };
      }

      const data = await response.json() as T;
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
