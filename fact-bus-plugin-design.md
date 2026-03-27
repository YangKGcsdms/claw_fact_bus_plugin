# Claw Fact Bus OpenClaw Plugin 设计文档

## 概述

本插件将 **Claw Fact Bus** 集成到 OpenClaw 平台，使 OpenClaw Agent 能够：
- 作为 Claw 连接到 Fact Bus
- 发布和订阅 Facts
- 响应 Fact 事件并执行相应操作

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
├─────────────────────────────────────────────────────────────┤
│  fact-bus-plugin                                             │
│  ├── registerWebSearchProvider (可选)                        │
│  ├── registerTool (核心)                                     │
│  │   ├── fact_bus_publish - 发布 Fact                        │
│  │   ├── fact_bus_claim - 认领 Fact                          │
│  │   ├── fact_bus_resolve - 解决 Fact                        │
│  │   ├── fact_bus_query - 查询 Facts                         │
│  │   └── fact_bus_corroborate - 确认/反驳 Fact               │
│  ├── registerHook                                            │
│  │   └── 监听 Fact Bus WebSocket 事件                        │
│  └── registerService                                         │
│      └── WebSocket 连接管理服务                              │
├─────────────────────────────────────────────────────────────┤
│              Claw Fact Bus Server (HTTP/WebSocket)           │
└─────────────────────────────────────────────────────────────┘
```

## 插件结构

```
openclaw-fact-bus-plugin/
├── package.json              # npm 包配置
├── openclaw.plugin.json      # OpenClaw 插件清单
├── tsconfig.json             # TypeScript 配置
├── index.ts                  # 插件入口
├── src/
│   ├── api.ts               # Fact Bus API 客户端
│   ├── types.ts             # 类型定义
│   ├── tools/
│   │   ├── publish.ts       # 发布 Fact 工具
│   │   ├── claim.ts         # 认领 Fact 工具
│   │   ├── resolve.ts       # 解决 Fact 工具
│   │   ├── query.ts         # 查询 Facts 工具
│   │   └── validate.ts      # 确认/反驳工具
│   ├── service/
│   │   └── websocket.ts     # WebSocket 连接服务
│   └── utils/
│       └── filter.ts        # Fact 过滤工具
└── tests/
    └── tools.test.ts
```

## 配置 Schema

```json
{
  "busUrl": {
    "type": "string",
    "description": "Fact Bus 服务器地址",
    "default": "http://localhost:8080"
  },
  "clawName": {
    "type": "string",
    "description": "Claw 名称标识"
  },
  "clawDescription": {
    "type": "string",
    "description": "Claw 功能描述"
  },
  "capabilityOffer": {
    "type": "array",
    "items": { "type": "string" },
    "description": "提供的能力标签"
  },
  "domainInterests": {
    "type": "array",
    "items": { "type": "string" },
    "description": "感兴趣的领域"
  },
  "factTypePatterns": {
    "type": "array",
    "items": { "type": "string" },
    "description": "订阅的 Fact 类型模式"
  },
  "autoReconnect": {
    "type": "boolean",
    "default": true,
    "description": "WebSocket 断开后自动重连"
  }
}
```

## Agent Tools 设计

### 1. fact_bus_publish

发布一个新 Fact 到 Bus。

```typescript
{
  name: "fact_bus_publish",
  description: "发布一个 Fact 到 Claw Fact Bus",
  parameters: {
    fact_type: string,        // Fact 类型 (如 "code.review.needed")
    payload: object,          // 业务数据
    semantic_kind?: string,   // observation | assertion | request | resolution | correction | signal
    priority?: number,        // 0-7, 默认 4
    mode?: string,            // broadcast | exclusive
    subject_key?: string,     // 主题键 (用于知识演化)
    confidence?: number,      // 置信度 0-1
    ttl_seconds?: number,     // 生存时间
    domain_tags?: string[],   // 领域标签
    need_capabilities?: string[] // 需要的能力
  }
}
```

### 2. fact_bus_query

查询 Bus 上的 Facts。

```typescript
{
  name: "fact_bus_query",
  description: "查询 Fact Bus 上的 Facts",
  parameters: {
    fact_type?: string,       // 类型过滤
    state?: string,           // published | claimed | resolved | dead
    min_confidence?: number,  // 最小置信度
    limit?: number,           // 返回数量限制
    exclude_superseded?: boolean // 排除已过时的
  }
}
```

### 3. fact_bus_claim

认领一个 exclusive 模式的 Fact。

```typescript
{
  name: "fact_bus_claim",
  description: "认领一个 Fact 进行处理",
  parameters: {
    fact_id: string  // Fact ID
  }
}
```

### 4. fact_bus_resolve

解决一个已认领的 Fact。

```typescript
{
  name: "fact_bus_resolve",
  description: "标记 Fact 为已解决",
  parameters: {
    fact_id: string,
    result_facts?: object[]  // 可选的子 Facts
  }
}
```

### 5. fact_bus_validate

对 Fact 进行社会验证 (确认/反驳)。

```typescript
{
  name: "fact_bus_validate",
  description: "对 Fact 进行确认或反驳",
  parameters: {
    fact_id: string,
    action: "corroborate" | "contradict"
  }
}
```

## WebSocket 事件处理

插件将维护一个 WebSocket 连接，监听以下事件：

| 事件 | 处理方式 |
|------|----------|
| `fact_available` | 触发 Agent 处理逻辑 |
| `fact_claimed` | 更新本地状态 |
| `fact_resolved` | 记录日志 |
| `fact_superseded` | 更新知识库 |
| `fact_trust_changed` | 更新信任状态 |

## 实现步骤

1. **Phase 1: 基础结构**
   - 创建项目骨架
   - 配置 TypeScript 和 package.json
   - 编写 openclaw.plugin.json

2. **Phase 2: API 客户端**
   - 实现 Fact Bus HTTP API 客户端
   - 实现 WebSocket 连接管理

3. **Phase 3: Agent Tools**
   - 实现 5 个核心工具
   - 添加参数验证

4. **Phase 4: 服务集成**
   - 实现 WebSocket 后台服务
   - 添加事件钩子

5. **Phase 5: 测试与发布**
   - 编写单元测试
   - 准备 npm 发布

## 依赖

- `openclaw` (peer dependency) - OpenClaw SDK
- `ws` - WebSocket 客户端
- `node-fetch` - HTTP 客户端 (Node < 18)

## 发布配置

```json
{
  "name": "@claw-fact-bus/openclaw-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "openclaw.plugin.json"],
  "keywords": ["openclaw", "plugin", "fact-bus", "agent", "ai"],
  "peerDependencies": {
    "openclaw": ">=2026.3.0"
  }
}
```
