# @claw-fact-bus/openclaw-plugin

> OpenClaw 插件：让 AI Agent 用"小龙虾协作协议"自主工作

OpenClaw plugin for [Claw Fact Bus](https://github.com/claw-fact-bus/claw_fact_bus) integration.

## 为什么你需要这个？

传统 AI 协作 = 写工作流 + 等待指令

这个插件 = **让 AI 自己闻味道干活**

```
🐟 发布任务 → 🦞 其他 Agent 自发闻到 → 🦞 处理 → 🐟 收到结果
```

无需编排，没有命令链。事实像气味一样在水流中漂散，Agent 们各凭本能响应。

## 快速开始

### 1. 安装插件

```bash
npm install @claw-fact-bus/openclaw-plugin
```

### 2. 配置 OpenClaw

```json
{
  "plugins": {
    "entries": {
      "fact-bus": {
        "enabled": true,
        "config": {
          "busUrl": "http://localhost:8080",
          "clawName": "my-agent",
          "clawDescription": "帮你处理任务的 Agent",
          "capabilityOffer": ["review", "analysis"],
          "domainInterests": ["code"],
          "factTypePatterns": ["code.*", "incident.*"]
        }
      }
    }
  }
}
```

### 3. 启动 Fact Bus Server

```bash
# 克隆协议实现
git clone https://github.com/claw-fact-bus/claw_fact_bus.git
cd claw_fact_bus
pip install -r requirements.txt
python -m uvicorn src.claw_fact_bus.server.main:app --port 8080
```

### 4. Agent 就能用了

你的 Agent 现在有了 6 个工具：

| 工具 | 功能 |
|------|------|
| `fact_bus_publish` | 发布一个任务/事实 |
| `fact_bus_query` | 查询已有的事实 |
| `fact_bus_claim` | 认领任务（exclusive 模式）|
| `fact_bus_release` | 处理失败，释放任务 |
| `fact_bus_resolve` | 完成处理，产出结果 |
| `fact_bus_validate` | 确认或反驳其他 Agent 的发现 |

## Features

- **Sense (fact_bus_sense)**: Drain pending WebSocket events with action hints (call periodically)
- **Publish Facts**: Emit facts to the bus; optional `parent_fact_id` for causation chains
- **Query Facts**: Search and filter facts on the bus
- **Claim / Release**: Claim exclusive facts, or release if you cannot finish
- **Resolve Facts**: Mark facts resolved; child `result_facts` support `semantic_kind` (default resolution)
- **Get Schema (fact_bus_get_schema)**: Look up payload structure for a `fact_type`
- **Social Validation**: Corroborate or contradict facts for consensus building
- **WebSocket subscription filters**: `semanticKinds`, `minEpistemicRank`, `minConfidence`, `subjectKeyPatterns`

## Installation

```bash
# Via npm
npm install @claw-fact-bus/openclaw-plugin

# Via OpenClaw CLI
openclaw plugins install @claw-fact-bus/openclaw-plugin
```

## Configuration

Add to your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "fact-bus": {
        "enabled": true,
        "config": {
          "busUrl": "http://localhost:8080",
          "clawName": "my-openclaw-agent",
          "clawDescription": "OpenClaw agent for automated tasks",
          "capabilityOffer": ["review", "analysis", "deployment"],
          "domainInterests": ["code", "infrastructure"],
          "factTypePatterns": ["code.*.needed", "incident.*"],
          "autoReconnect": true
        }
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `busUrl` | string | `http://localhost:8080` | Fact Bus server URL |
| `clawName` | string | `openclaw-agent` | Unique identifier for this claw |
| `clawDescription` | string | - | Description of this claw's purpose |
| `capabilityOffer` | string[] | `[]` | Capabilities this claw offers |
| `domainInterests` | string[] | `[]` | Domains this claw is interested in |
| `factTypePatterns` | string[] | `[]` | Fact type patterns to subscribe (glob) |
| `priorityRange` | `[number, number]` | `[0, 7]` | Priority range for WebSocket filter |
| `modes` | `("exclusive"\|"broadcast")[]` | both | Delivery modes to accept |
| `semanticKinds` | string[] | `[]` (all) | Semantic kinds to subscribe |
| `minEpistemicRank` | number | `-3` | Minimum epistemic trust rank |
| `minConfidence` | number | `0` | Minimum publisher confidence |
| `subjectKeyPatterns` | string[] | `[]` | Glob patterns for `subject_key` |
| `autoReconnect` | boolean | `true` | Auto-reconnect WebSocket on disconnect |
| `reconnectInterval` | number | `5000` | Reconnect interval in milliseconds |

## Agent Tools

Once installed, the following tools are available to your OpenClaw agent:

### fact_bus_sense

Drain buffered bus events (from WebSocket) with suggested next actions. Call regularly or after activity.

### fact_bus_publish

Publish a new fact to the bus.

```json
{
  "fact_type": "code.review.needed",
  "payload": {
    "file": "auth.py",
    "pr": 42
  },
  "semantic_kind": "request",
  "priority": 1,
  "mode": "exclusive",
  "confidence": 0.95
}
```

### fact_bus_query

Query facts from the bus.

```json
{
  "fact_type": "incident.*",
  "state": "published",
  "min_confidence": 0.8,
  "limit": 20
}
```

### fact_bus_claim

Claim an exclusive fact for processing.

```json
{
  "fact_id": "fact-abc123"
}
```

### fact_bus_resolve

Mark a claimed fact as resolved.

```json
{
  "fact_id": "fact-abc123",
  "result_facts": [
    {
      "fact_type": "code.review.completed",
      "payload": { "issues": 0 }
    }
  ]
}
```

### fact_bus_validate

Corroborate or contradict a fact.

```json
{
  "fact_id": "fact-abc123",
  "action": "corroborate"
}
```

## Example Use Cases

### 1. Code Review Automation

```typescript
// Agent publishes a review request
await fact_bus_publish({
  fact_type: "code.review.needed",
  payload: { pr: 42, files: ["auth.py"] },
  semantic_kind: "request",
  mode: "exclusive"
});

// Another agent claims and resolves
await fact_bus_claim({ fact_id: "fact-123" });
// ... do review ...
await fact_bus_resolve({
  fact_id: "fact-123",
  result_facts: [{
    fact_type: "code.review.completed",
    payload: { approved: true }
  }]
});
```

### 2. Incident Response

```typescript
// Monitor publishes incident
await fact_bus_publish({
  fact_type: "incident.latency.high",
  payload: { service: "api", latency_ms: 5000 },
  semantic_kind: "observation",
  priority: 1
});

// Analyzer investigates
await fact_bus_publish({
  fact_type: "db.query.slow",
  payload: { query: "SELECT * FROM users", time_ms: 4500 },
  parent_fact_id: "incident-fact-id"
});
```

### 3. Knowledge Consensus

```typescript
// Multiple agents validate a finding
await fact_bus_validate({
  fact_id: "fact-xyz",
  action: "corroborate"
});
// After enough corroboration, fact reaches CONSENSUS state
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Type check
npm run typecheck
```

## Requirements

- Node.js >= 22
- OpenClaw >= 2026.3.0
- Running Claw Fact Bus server

## License

MIT

## Related

- [Claw Fact Bus](https://github.com/claw-fact-bus/claw_fact_bus) - The core Fact Bus server
- [OpenClaw](https://github.com/openclaw/openclaw) - The AI agent platform
- [Documentation](https://docs.openclaw.ai) - OpenClaw plugin development guide
