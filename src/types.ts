/**
 * Claw Fact Bus Types
 * Based on the Claw Fact Bus protocol specification (Python types.py)
 */

// ============ Enums ============

export type SemanticKind =
  | "observation"
  | "assertion"
  | "request"
  | "resolution"
  | "correction"
  | "signal";

export type FactMode = "broadcast" | "exclusive";

export type FactState =
  | "created"
  | "published"
  | "matched"
  | "claimed"
  | "processing"
  | "resolved"
  | "dead";

export type EpistemicState =
  | "asserted"
  | "corroborated"
  | "consensus"
  | "contested"
  | "refuted"
  | "superseded";

export type ClawState = "active" | "degraded" | "isolated" | "offline";

// ============ Fact ============

export interface Fact {
  // Immutable record (frozen after publish)
  fact_id: string;
  fact_type: string;
  semantic_kind: SemanticKind;
  payload: Record<string, unknown>;
  domain_tags: string[];
  need_capabilities: string[];
  priority: number; // 0-7
  mode: FactMode;
  source_claw_id: string;
  causation_chain: string[];
  causation_depth: number;
  subject_key: string;
  supersedes: string;
  created_at: number;
  ttl_seconds: number;
  schema_version: string;
  /** Absent in JSON means unspecified (not "certain"). */
  confidence: number | null;
  content_hash: string;
  signature: string;
  protocol_version: string;

  // Mutable bus state (managed by engine)
  state: FactState;
  epistemic_state: EpistemicState;
  claimed_by: string | null;
  resolved_at: number | null;
  effective_priority: number | null;
  sequence_number: number;
  superseded_by: string;
  corroborations: string[];
  contradictions: string[];

  // Computed property
  parent_fact_id: string;
}

// ============ Request Types (matching FastAPI Pydantic models) ============

export interface FactCreateRequest {
  fact_type: string;
  semantic_kind?: SemanticKind;
  payload?: Record<string, unknown>;
  domain_tags?: string[];
  need_capabilities?: string[];
  priority?: number; // 0-7, default 3
  mode?: FactMode;
  source_claw_id: string;
  token?: string;
  ttl_seconds?: number; // default 300, min 10
  schema_version?: string;
  confidence?: number | null; // 0-1; omit = unspecified
  causation_chain?: string[];
  causation_depth?: number;
  parent_fact_id?: string;
  subject_key?: string;
  supersedes?: string;
  content_hash?: string;
  created_at?: number;
}

export interface ClawConnectRequest {
  name: string;
  description?: string;
  capability_offer?: string[];
  domain_interests?: string[];
  fact_type_patterns?: string[];
  priority_range?: [number, number];
  modes?: FactMode[];
  max_concurrent_claims?: number;
  semantic_kinds?: SemanticKind[];
  min_epistemic_rank?: number;
  min_confidence?: number;
  exclude_superseded?: boolean;
  subject_key_patterns?: string[];
}

export interface ClawResponse {
  claw_id: string;
  name: string;
  state: string;
  reliability_score: number;
  token?: string;
}

export interface ClaimRequest {
  claw_id: string;
  token?: string;
}

export interface ResolveRequest {
  claw_id: string;
  token?: string;
  result_facts?: Array<{
    fact_type: string;
    semantic_kind?: SemanticKind;
    payload?: Record<string, unknown>;
    domain_tags?: string[];
    need_capabilities?: string[];
    priority?: number;
    mode?: string;
    schema_version?: string;
  }>;
}

export interface CorroborateRequest {
  claw_id: string;
  token?: string;
}

export interface ContradictRequest {
  claw_id: string;
  token?: string;
}

// ============ Query Types ============

export interface QueryFactsParams {
  fact_type?: string;
  state?: FactState;
  source_claw_id?: string;
  limit?: number; // 1-1000, default 100
}

// ============ WebSocket Types ============

export type BusEventType =
  | "fact_available"
  | "fact_claimed"
  | "fact_resolved"
  | "fact_dead"
  | "fact_superseded"
  | "fact_trust_changed"
  | "claw_state_changed";

export interface BusEvent {
  event_type: BusEventType;
  fact?: Fact;
  claw_id?: string;
  detail?: string | Record<string, unknown>;
  timestamp: number;
}

export interface WebSocketSubscribeRequest {
  action: "subscribe";
  name?: string;
  filter?: {
    capability_offer?: string[];
    domain_interests?: string[];
    fact_type_patterns?: string[];
    priority_range?: [number, number];
    modes?: string[]; // ["exclusive", "broadcast"]
    semantic_kinds?: string[];
    min_epistemic_rank?: number;
    min_confidence?: number;
    exclude_superseded?: boolean;
    subject_key_patterns?: string[];
  };
}

// ============ Plugin Config Types ============

export interface FactBusPluginConfig {
  busUrl: string;
  clawName?: string;
  clawDescription?: string;
  capabilityOffer?: string[];
  domainInterests?: string[];
  factTypePatterns?: string[];
  priorityRange?: [number, number];
  modes?: FactMode[];
  /** Filter subscription: only these semantic kinds (empty = all) */
  semanticKinds?: SemanticKind[];
  minEpistemicRank?: number;
  minConfidence?: number;
  subjectKeyPatterns?: string[];
  /** When true, filter excludes superseded facts (default true). */
  excludeSuperseded?: boolean;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  /** When true, spawn a subagent on each matching fact_available (default true). */
  autoProcess?: boolean;
  /** Max concurrent subagent runs for auto-processing (default 3). Excess events go to pending queue. */
  maxConcurrentSubagents?: number;
}

// ============ Tool Parameter Types ============

export interface PublishFactParams {
  fact_type: string;
  payload: Record<string, unknown>;
  semantic_kind?: SemanticKind;
  priority?: number;
  mode?: FactMode;
  subject_key?: string;
  confidence?: number;
  ttl_seconds?: number;
  domain_tags?: string[];
  need_capabilities?: string[];
  /** Builds causation_chain from parent fact (depth +1) */
  parent_fact_id?: string;
}

export interface QueryFactsToolParams {
  fact_type?: string;
  state?: FactState;
  source_claw_id?: string;
  limit?: number;
}

export interface ClaimFactParams {
  fact_id: string;
}

export interface ResolveFactParams {
  fact_id: string;
  result_facts?: Array<{
    fact_type: string;
    semantic_kind?: SemanticKind;
    payload?: Record<string, unknown>;
    domain_tags?: string[];
    need_capabilities?: string[];
    priority?: number;
    mode?: string;
  }>;
}

export interface SenseFactParams {
  limit?: number;
}

export interface GetSchemaParams {
  fact_type: string;
}

export interface ReleaseFactParams {
  fact_id: string;
}

export interface ValidateFactParams {
  fact_id: string;
  action: "corroborate" | "contradict";
}

// ============ Schema Registry Types ============

export interface SchemaInfo {
  fact_type: string;
  version: string;
  schema: Record<string, unknown>;
  created_at?: number;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  fact_type: string;
  schema_version?: string;
}

// ============ Claw Activity Types ============

export interface ActivityLogEntry {
  timestamp: number;
  action: string;
  fact_id?: string;
  detail?: string | Record<string, unknown>;
}

// ============ API Response Types ============

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface StatsResponse {
  facts: {
    total: number;
    by_state: Record<FactState, number>;
    by_epistemic: Record<EpistemicState, number>;
  };
  claws: {
    total: number;
    active: number;
  };
  store?: {
    size_bytes: number;
    entry_count: number;
  };
}
