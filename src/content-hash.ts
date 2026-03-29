/**
 * Canonical content_hash (protocol/IMPLEMENTATION-NOTES.md) — must match Python
 * Fact.canonical_immutable_record + json.dumps(..., sort_keys=True, ensure_ascii=False).
 */

import { createHash } from "crypto";

/** Recursive JSON.stringify with sorted object keys (matches Python sort_keys=True). */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(o[k])}`).join(",")}}`;
}

export interface CanonicalFactFields {
  fact_type: string;
  payload: Record<string, unknown>;
  source_claw_id: string;
  created_at: number;
  mode: string;
  priority: number;
  ttl_seconds: number;
  causation_depth: number;
  parent_fact_id?: string;
  confidence?: number | null;
  domain_tags?: string[];
  need_capabilities?: string[];
}

/** Build the canonical dict for hashing (same fields / omission rules as Python). */
export function buildCanonicalImmutableRecord(fields: CanonicalFactFields): Record<string, unknown> {
  const record: Record<string, unknown> = {
    fact_type: fields.fact_type,
    payload: fields.payload,
    source_claw_id: fields.source_claw_id,
    created_at: fields.created_at,
    mode: fields.mode,
    priority: fields.priority,
    ttl_seconds: fields.ttl_seconds,
    causation_depth: fields.causation_depth,
  };
  if (fields.parent_fact_id) {
    record.parent_fact_id = fields.parent_fact_id;
  }
  if (fields.confidence !== undefined && fields.confidence !== null) {
    record.confidence = fields.confidence;
  }
  if (fields.domain_tags?.length) {
    record.domain_tags = [...fields.domain_tags].sort();
  }
  if (fields.need_capabilities?.length) {
    record.need_capabilities = [...fields.need_capabilities].sort();
  }
  return record;
}

export function expectedContentHash(fields: CanonicalFactFields): string {
  const rec = buildCanonicalImmutableRecord(fields);
  const canonical = canonicalJsonStringify(rec);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
