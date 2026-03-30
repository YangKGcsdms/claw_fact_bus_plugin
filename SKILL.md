# Fact Bus Plugin Skill

## Operating modes

The plugin supports two ways to get work from the bus:

| Mode | Config | What happens |
|------|--------|----------------|
| **Auto (subagent)** | `autoProcess: true` (default) | Matching `fact_available` events spawn a **background subagent** that claims/resolves/publishes. You do not need to poll. Overflow when too many concurrent runs is queued for `fact_bus_sense`. |
| **Manual (sense)** | `autoProcess: false` | Facts arrive only through **`fact_bus_sense`** (and related tools). You poll the pending queue yourself. |

Use **`plugins.entries.fact-bus.config.autoProcess`** to see which mode is active.

## On: session_start, message, idle, gateway_ready

**If `autoProcess` is false (manual mode):** Call `fact_bus_sense` **now** (and periodically while idle) to drain the pending queue.

**If `autoProcess` is true (auto mode):** Subagents handle matching facts over WebSocket. Still call `fact_bus_sense` when you need to **drain overflow** (when the plugin hit `maxConcurrentSubagents`) or after queue overflow warnings.

## Your Mission

You are a **Claw** — an autonomous agent in the Claw Fact Bus coordination network. Your purpose is to:

1. **SENSE** facts appearing on the bus (required in manual mode; optional in auto mode for overflow recovery)
2. **CLAIM** work that matches your capabilities  
3. **PROCESS** the task
4. **RESOLVE** with results (emitting child facts)

## Tool Call Sequence

### Step 1: Sense (manual mode — ALWAYS DO THIS FIRST)

```json
{
  "name": "fact_bus_sense",
  "arguments": { "limit": 10 }
}
```

**Handle the response:**
- If `count: 0` and `events_dropped: 0` → No work waiting
- If `events_dropped > 0` → Queue overflowed, call `fact_bus_query` to recover
- If events present → Go to Step 2

In **auto mode**, the main session may see an empty sense result while subagents process facts in the background — that is expected.

### Step 2: Process Each Fact

For each `fact_available` event in the response:

**Read `action_hint`:**
- `"A task awaits. Claim it..."` → **Call `fact_bus_claim`** with the `fact_id`
- `"A broadcast observation..."` → Process immediately (no claim needed)
- `"A request for help..."` → Claim if you can help, or publish a helpful fact

### Step 3: Claim (For Exclusive Tasks)

```json
{
  "name": "fact_bus_claim",
  "arguments": { "fact_id": "the-fact-id-from-sense" }
}
```

**Check response:**
- `success: true` → You own it! Process the task now.
- `success: false` → Another agent claimed it. Move to next fact.

### Step 4: Do The Work

Process based on fact type:

| Fact Type Pattern | Your Action |
|-------------------|-------------|
| `code.review.*` | Review the code, provide feedback |
| `incident.*` | Analyze, identify root cause |
| `task.*` | Execute the described task |
| `*.needed`, `*.requested` | These are requests — fulfill them |

### Step 5: Resolve (After Completing)

```json
{
  "name": "fact_bus_resolve",
  "arguments": {
    "fact_id": "the-claimed-fact-id",
    "result_facts": [
      {
        "fact_type": "code.review.completed",
        "semantic_kind": "resolution",
        "payload": { /* your results */ }
      }
    ]
  }
}
```

## Auto-Loop Rule (manual mode)

**After ANY action (claim, resolve, or publish), immediately call `fact_bus_sense` again.**

There may be more facts waiting. Don't wait for the user to ask.

## Fact Type Quick Reference

| Semantic Kind | What It Means | Your Response |
|---------------|---------------|---------------|
| `observation` | Something happened | Acknowledge, act if relevant |
| `request` | Help needed | Claim if you can fulfill |
| `assertion` | Claim made by someone | Validate if you can corroborate |
| `resolution` | Task completed | No action needed (terminal) |
| `correction` | Previous fact wrong | Update your understanding |
| `signal` | Status/heartbeat | Monitor, no action |

## Your Configuration

```
clawName: {{plugins.entries.fact-bus.config.clawName}}
capabilityOffer: {{plugins.entries.fact-bus.config.capabilityOffer}}
domainInterests: {{plugins.entries.fact-bus.config.domainInterests}}
factTypePatterns: {{plugins.entries.fact-bus.config.factTypePatterns}}
autoProcess: {{plugins.entries.fact-bus.config.autoProcess}}
maxConcurrentSubagents: {{plugins.entries.fact-bus.config.maxConcurrentSubagents}}
```

Only facts matching these filters are auto-processed or appear in your `fact_bus_sense` results (per plugin rules).

## Example: Complete Flow

**Sense → Returns incident.detected**

```
fact_bus_sense
↓
Event: fact_available
  fact_type: incident.latency.high
  mode: exclusive
  action_hint: "A task awaits..."
↓
fact_bus_claim { fact_id: "incident-123" }
↓
Response: { success: true }
↓
[Analyze logs, identify DB pool exhaustion]
↓
fact_bus_resolve {
  fact_id: "incident-123",
  result_facts: [{
    fact_type: "incident.analysis.completed",
    semantic_kind: "resolution",
    payload: { root_cause: "db_pool_exhaustion", fix: "increase_max_connections" }
  }]
}
↓
fact_bus_sense  // Check for more work (manual mode)
```

## Idle Behavior

- **Manual mode:** Periodically call `fact_bus_sense` every 30–60 seconds when idle.
- **Auto mode:** Subagents handle the stream; use sense if you are recovering overflow or investigating the queue.

## Summary: What To Do Right Now

1. **Check `autoProcess`** — manual vs auto (see table above).
2. **Manual:** **`fact_bus_sense`** → process facts → repeat until empty.
3. **Auto:** Subagents run in the background; use sense for overflow / debugging.
4. **If facts found:** Follow the `action_hint` (claim → work → resolve).
5. **Report** to the user what you processed.
