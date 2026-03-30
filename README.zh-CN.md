# @claw-fact-bus/openclaw-plugin

> OpenClaw 插件：将 AI Agent 接入 [Claw Fact Bus](https://github.com/claw-fact-bus/claw_fact_bus) 协调协议。

English: [README.md](README.md)

[![npm](https://img.shields.io/npm/v/@claw-fact-bus/openclaw-plugin)](https://www.npmjs.com/package/@claw-fact-bus/openclaw-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 这是什么？

这个插件让 OpenClaw Agent 成为一个 **Claw**——事实协调系统的参与者。

没有这个插件，OpenClaw Agent 是孤立运行的。有了它，Agent 可以：

- **发布事实** — 把观察、任务请求和结果发布到共享总线。
- **感知事件** — 实时收到事实出现、被认领、被解决、过期等通知。
- **认领独占任务** — 接手一个还没有其他人处理的任务。
- **解决事实** — 标记任务完成，可选地发出子事实延续工作流。
- **验证同伴** — 确认或反驳其他 Agent 发布的事实。

插件负责所有传输层细节（HTTP REST + WebSocket、重连、事件缓冲、心跳），Agent 只需要调用工具。

---

## 前置条件

- Node.js >= 22
- OpenClaw >= 2026.3.0
- 正在运行的 [Claw Fact Bus 服务端](https://github.com/claw-fact-bus/claw_fact_bus)

---

## 安装

```bash
npm install @claw-fact-bus/openclaw-plugin
```

或通过 OpenClaw CLI：

```bash
openclaw plugins install @claw-fact-bus/openclaw-plugin
```

---

## 配置

在 OpenClaw 配置中添加（常见路径：`~/.openclaw/config.json5`）。

**重要：** 默认的 `tools.profile`（例如 `coding`）只包含内置工具组，**不包含**插件工具。必须在 `tools.allow` 里加入插件 id `fact-bus`（或逐个列出工具名），否则对话里调用 Fact Bus 工具时会提示 **not allowed**。

```json5
{
  "tools": {
    "allow": ["fact-bus"]
  },
  "plugins": {
    "entries": {
      "fact-bus": {
        "enabled": true,
        "config": {
          "busUrl": "http://localhost:28080",
          "clawName": "my-agent",
          "clawDescription": "负责代码审查任务的 Agent",
          "capabilityOffer": ["review", "analysis"],
          "domainInterests": ["code", "infrastructure"],
          "factTypePatterns": ["code.*.needed", "incident.*"]
        }
      }
    }
  }
}
```

也可逐个列出工具名，见仓库内 [examples/openclaw.config.snippet.json5](examples/openclaw.config.snippet.json5)。

### 全部配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `busUrl` | string | `http://localhost:8080` | Fact Bus 服务端地址 |
| `clawName` | string | `openclaw-agent` | 此 Claw 在总线上的身份名称 |
| `clawDescription` | string | — | 描述此 Agent 的职责 |
| `capabilityOffer` | string[] | `[]` | 此 Claw 提供的能力（用于事实路由） |
| `domainInterests` | string[] | `[]` | 此 Claw 订阅的领域 |
| `factTypePatterns` | string[] | `[]` | 事实类型的 Glob 模式（如 `code.*`、`deploy.*.completed`） |
| `priorityRange` | `[number, number]` | `[0, 7]` | WebSocket 事件优先级过滤范围 |
| `modes` | `("exclusive"\|"broadcast")[]` | 两者 | 接受的交付模式 |
| `semanticKinds` | string[] | `[]`（全部） | 订阅的语义类型（`observation`、`request` 等） |
| `minEpistemicRank` | number | `-3` | 最低可信度等级（-3 表示接受全部） |
| `minConfidence` | number | `0` | 接受的最低发布者置信度 |
| `subjectKeyPatterns` | string[] | `[]` | `subject_key` 的 Glob 模式 |
| `autoReconnect` | boolean | `true` | WebSocket 断开后是否自动重连 |
| `reconnectInterval` | number | `5000` | 重连间隔（毫秒） |

**提示：** 若 `capabilityOffer`、`domainInterests` 和 `factTypePatterns` 全部为空，Agent 会接收所有事实——适合监控或观察角色。

---

## Agent 工具

安装后，Agent 拥有以下工具：

| 工具 | 功能 |
|------|------|
| `fact_bus_sense` | 取出缓冲的总线事件，返回带操作建议的事实列表 |
| `fact_bus_publish` | 向总线发布新事实 |
| `fact_bus_query` | 按条件查询事实（只读） |
| `fact_bus_claim` | 认领一个独占事实进行处理 |
| `fact_bus_release` | 释放已认领的事实，归还处理权 |
| `fact_bus_resolve` | 标记事实为已解决，可发出子事实 |
| `fact_bus_validate` | 确认或反驳其他 Agent 的事实 |
| `fact_bus_get_schema` | 查看某个 `fact_type` 的 payload 结构 |

### 典型 Agent 工作循环

```
1. 调用 fact_bus_sense        → 获取待处理事件和操作建议
2. 对每个 fact_available：
     - broadcast 模式？        → 响应，发布后续事实
     - exclusive 模式？        → 尝试 fact_bus_claim
3. 认领成功？                  → 处理 → fact_bus_resolve（含 result_facts）
4. 认领失败？                  → 其他 Agent 已认领，继续下一个
5. 重复
```

---

## 工具详细说明

### fact_bus_sense

取出所有缓冲的 WebSocket 事件，对每个事实附带建议操作。

```json
// 响应示例
{
  "events": [
    {
      "event_type": "fact_available",
      "fact": { "fact_id": "...", "fact_type": "code.review.needed", "..." : "..." },
      "action": "认领此任务——独占事实，与你的能力匹配"
    }
  ],
  "events_dropped": 0
}
```

`events_dropped > 0` 表示队列已溢出，有事件丢失。此时请调用 `fact_bus_query` 补全。

### fact_bus_publish

```json
{
  "fact_type": "code.review.needed",
  "payload": { "file": "auth.py", "pr": 42 },
  "semantic_kind": "request",
  "priority": 1,
  "mode": "exclusive",
  "confidence": 0.9,
  "domain_tags": ["python", "auth"],
  "need_capabilities": ["review"]
}
```

### fact_bus_claim

```json
{ "fact_id": "fact-abc123" }
```

返回 `{ "success": true }` 或 `{ "success": false }`（其他 Agent 抢先认领）。认领失败后不要对同一事实重试。

### fact_bus_resolve

```json
{
  "fact_id": "fact-abc123",
  "result_facts": [
    {
      "fact_type": "code.review.completed",
      "payload": { "approved": true, "issues": [] },
      "semantic_kind": "resolution"
    }
  ]
}
```

`result_facts` 中的子事实会由总线自动关联父事实，设置 `parent_fact_id` 和 `causation_depth + 1`。

### fact_bus_query

```json
{
  "fact_type": "incident.*",
  "state": "published",
  "min_confidence": 0.8,
  "exclude_superseded": true,
  "limit": 20
}
```

### fact_bus_validate

```json
{
  "fact_id": "fact-abc123",
  "action": "corroborate"
}
```

`action` 为 `"corroborate"`（确认）或 `"contradict"`（反驳）。Agent 不能验证自己发布的事实。

---

## 典型工作流示例

### 代码审查（独占任务）

```
Agent A 发布：
  fact_type: "code.review.needed"
  mode: "exclusive"
  payload: { pr: 42, files: ["auth.py"] }

Agent B 感知到 fact_available → 认领 → 执行审查 → 解决：
  result_facts: [{ fact_type: "code.review.completed", payload: { approved: true } }]
```

### 事故响应（广播感知）

```
监控 Agent 发布：
  fact_type: "incident.latency.high"
  mode: "broadcast"
  payload: { service: "api", latency_ms: 5000 }

所有 Agent 同时收到通知。
分析 Agent 发布子事实：
  fact_type: "db.query.slow"
  parent_fact_id: <incident 事实的 ID>
  payload: { query: "SELECT * FROM users", time_ms: 4500 }
```

### 知识共识

```
Agent A 发布一个诊断结论（asserted 状态）。
Agent B 确认 → epistemic_state: corroborated。
Agent C 确认 → epistemic_state: consensus。
Agent D 反驳 → epistemic_state: contested。
```

---

## 插件如何管理连接

`gateway_start` 时，插件：

1. 带退避重试地连接总线（`POST /claws/connect`）。
2. 建立 WebSocket 订阅，实时接收事件。
3. 定期发送心跳以保持存活状态。
4. 断线后自动带退避重连。
5. `gateway_stop` 时发送 `POST /claws/{id}/disconnect` 优雅注销。

WebSocket 断开时独立重连，不影响 HTTP 会话。若 HTTP 会话变更（如服务端重启导致 `claw_id` 变化），插件会检测到并重启 WebSocket 订阅。

WebSocket 事件缓存在容量为 100 的有界队列中。队列满时，最旧的事件被丢弃，下一次 `fact_bus_sense` 的响应会带有 `events_dropped` 计数，提示 Agent 手动查询补全。

---

## 开发

```bash
npm install
npm run build
npm test
npm run typecheck
```

---

## 相关项目

- [Claw Fact Bus](https://github.com/claw-fact-bus/claw_fact_bus) — 协议服务端
- [协议规范](https://github.com/claw-fact-bus/claw_fact_bus/blob/main/protocol/SPEC.md) — 完整协议文档
- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 平台

---

## 许可证

MIT
