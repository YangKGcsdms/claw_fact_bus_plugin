/**
 * WebSocket Service for Fact Bus real-time events
 * Matches the WebSocket protocol in claw_fact_bus/server/app.py
 */

import type {
  BusEvent,
  BusEventType,
  WebSocketSubscribeRequest,
  FactBusPluginConfig,
} from "./types.js";
import type { FactBusClient } from "./api.js";

// Event handler types
export type BusEventHandler<T extends BusEventType = BusEventType> = (
  event: Extract<BusEvent, { event_type: T }>
) => void | Promise<void>;

export interface WebSocketServiceOptions {
  client: FactBusClient;
  config: FactBusPluginConfig;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onEvent?: (event: BusEvent) => void;
}

// WebSocket readyState constants
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// Close event interface for cross-platform compatibility
interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

export class FactBusWebSocketService {
  private ws: WebSocket | null = null;
  private client: FactBusClient;
  private config: FactBusPluginConfig;
  private logger: WebSocketServiceOptions["logger"];
  private onEvent?: (event: BusEvent) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;

  // Event handlers map for typed event handling
  private eventHandlers: Map<BusEventType, Set<BusEventHandler<BusEventType>>> = new Map();

  // Connection state
  private connectionAttempts = 0;
  private maxConnectionAttempts = 10;
  private lastConnectedAt: number | null = null;

  constructor(options: WebSocketServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger;
    this.onEvent = options.onEvent;
  }

  // ============ Event Subscription API ============

  /**
   * Subscribe to a specific event type
   */
  on<T extends BusEventType>(eventType: T, handler: BusEventHandler<T>): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }
    const handlers = this.eventHandlers.get(eventType)!;
    // Cast handler to generic type for storage
    handlers.add(handler as unknown as BusEventHandler<BusEventType>);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler as unknown as BusEventHandler<BusEventType>);
      if (handlers.size === 0) {
        this.eventHandlers.delete(eventType);
      }
    };
  }

  /**
   * Subscribe to all events
   */
  onAll(handler: (event: BusEvent) => void | Promise<void>): () => void {
    return this.on("*" as BusEventType, handler as BusEventHandler<BusEventType>);
  }

  /**
   * Remove all handlers for an event type
   */
  off(eventType: BusEventType): void {
    this.eventHandlers.delete(eventType);
  }

  // ============ Lifecycle ============

  async start(): Promise<void> {
    if (!this.client.isConnected) {
      this.logger.warn("Cannot start WebSocket: client not connected");
      return;
    }

    this.shouldReconnect = this.config.autoReconnect ?? true;
    this.connectionAttempts = 0;
    await this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;
    this.disconnect();
    this.eventHandlers.clear();
  }

  // ============ Connection Management ============

  private async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WS_OPEN) {
      return;
    }

    this.isConnecting = true;
    this.connectionAttempts++;

    try {
      const wsUrl = this.client.getWebSocketUrl();
      const clawId = this.client.currentClawId;

      if (!clawId) {
        this.logger.error("No claw ID available for WebSocket connection");
        this.isConnecting = false;
        return;
      }

      const wsEndpoint = `${wsUrl}/ws/${clawId}`;
      this.logger.info(`Connecting to WebSocket: ${wsEndpoint} (attempt ${this.connectionAttempts})`);

      // Create WebSocket - use global WebSocket or import ws package
      const WebSocketImpl = await this.getWebSocketImpl();
      this.ws = new WebSocketImpl(wsEndpoint);

      this.setupEventHandlers();
    } catch (error) {
      this.logger.error("Failed to connect WebSocket:", error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private async getWebSocketImpl(): Promise<typeof WebSocket> {
    // In browser environment, use global WebSocket
    if (typeof WebSocket !== "undefined") {
      return WebSocket;
    }

    // In Node.js environment, dynamically import ws package
    try {
      const wsModule = await import("ws");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return wsModule.default || (wsModule as any).WebSocket;
    } catch {
      throw new Error(
        "WebSocket is not available. Please install 'ws' package: npm install ws"
      );
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.logger.info("WebSocket connected");
      this.isConnecting = false;
      this.connectionAttempts = 0;
      this.lastConnectedAt = Date.now();
      this.subscribe();
      this.startHeartbeat();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = (_error: Event) => {
      this.logger.error("WebSocket error occurred");
    };

    this.ws.onclose = (event: WebSocketCloseEvent) => {
      this.logger.info(`WebSocket disconnected: code=${event.code}, reason=${event.reason}`);
      this.isConnecting = false;
      this.stopHeartbeat();
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Handle subscription confirmation
      if (message.status === "subscribed") {
        this.logger.info("WebSocket subscribed:", message.claw_id);
        return;
      }

      // Handle pong
      if (message.type === "pong") {
        this.logger.debug("WebSocket pong received");
        return;
      }

      // Handle filter update confirmation
      if (message.status === "filter_updated") {
        this.logger.debug("WebSocket filter updated");
        return;
      }

      // Handle error
      if (message.error) {
        this.logger.error("WebSocket error from server:", message.error);
        return;
      }

      // Handle bus event
      const busEvent = message as BusEvent;
      this.logger.debug(`WebSocket event: ${busEvent.event_type}`);
      this.dispatchEvent(busEvent);
    } catch (error) {
      this.logger.error("Failed to parse WebSocket message:", error);
    }
  }

  private dispatchEvent(event: BusEvent): void {
    // Call the legacy onEvent callback
    this.onEvent?.(event);

    // Dispatch to typed handlers
    const handlers = this.eventHandlers.get(event.event_type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.logger.error(`Error in event handler for ${event.event_type}:`, err);
            });
          }
        } catch (err) {
          this.logger.error(`Error in event handler for ${event.event_type}:`, err);
        }
      }
    }

    // Dispatch to wildcard handlers
    const wildcardHandlers = this.eventHandlers.get("*" as BusEventType);
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.logger.error("Error in wildcard event handler:", err);
            });
          }
        } catch (err) {
          this.logger.error("Error in wildcard event handler:", err);
        }
      }
    }
  }

  // ============ Subscription ============

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    const subscribeRequest: WebSocketSubscribeRequest = {
      action: "subscribe",
      name: this.config.clawName,
      filter: {
        capability_offer: this.config.capabilityOffer || [],
        domain_interests: this.config.domainInterests || [],
        fact_type_patterns: this.config.factTypePatterns || [],
        priority_range: this.config.priorityRange || [0, 7],
        modes: this.config.modes?.map((m) => m) || ["exclusive", "broadcast"],
        semantic_kinds: this.config.semanticKinds || [],
        min_epistemic_rank: this.config.minEpistemicRank ?? -3,
        min_confidence: this.config.minConfidence ?? 0,
        exclude_superseded: true,
        subject_key_patterns: this.config.subjectKeyPatterns || [],
      },
    };

    this.logger.debug("Subscribing with filter:", subscribeRequest.filter);
    this.ws.send(JSON.stringify(subscribeRequest));
  }

  // ============ Heartbeat ============

  private startHeartbeat(): void {
    this.stopHeartbeat();

    // Send heartbeat every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ action: "heartbeat" }));
  }

  // ============ Filter Management ============

  updateFilter(filter: WebSocketSubscribeRequest["filter"]): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ action: "update_filter", filter }));
  }

  // ============ Reconnection ============

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      this.logger.error(
        `Max reconnection attempts (${this.maxConnectionAttempts}) reached. Stopping reconnection.`
      );
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Exponential backoff with jitter
    const baseInterval = this.config.reconnectInterval ?? 5000;
    const backoff = Math.min(baseInterval * Math.pow(2, this.connectionAttempts - 1), 60000);
    const jitter = Math.random() * 1000;
    const delay = backoff + jitter;

    this.logger.info(`Reconnecting in ${Math.round(delay)}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private disconnect(): void {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      if (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING) {
        this.ws.close(1000, "Client disconnecting");
      }
      this.ws = null;
    }
  }

  // ============ Public API ============

  get isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  get connectionState(): "connecting" | "connected" | "disconnecting" | "disconnected" {
    if (!this.ws) return "disconnected";
    switch (this.ws.readyState) {
      case WS_CONNECTING:
        return "connecting";
      case WS_OPEN:
        return "connected";
      case WS_CLOSING:
        return "disconnecting";
      case WS_CLOSED:
      default:
        return "disconnected";
    }
  }

  get stats(): {
    connectionAttempts: number;
    lastConnectedAt: number | null;
    isConnected: boolean;
  } {
    return {
      connectionAttempts: this.connectionAttempts,
      lastConnectedAt: this.lastConnectedAt,
      isConnected: this.isConnected,
    };
  }
}
