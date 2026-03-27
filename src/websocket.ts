/**
 * WebSocket Service for Fact Bus real-time events
 * Matches the WebSocket protocol in claw_fact_bus/server/app.py
 */

import type {
  BusEvent,
  WebSocketSubscribeRequest,
  FactBusPluginConfig,
} from "./types.js";
import type { FactBusClient } from "./api.js";

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

export class FactBusWebSocketService {
  private ws: WebSocket | null = null;
  private client: FactBusClient;
  private config: FactBusPluginConfig;
  private logger: WebSocketServiceOptions["logger"];
  private onEvent?: (event: BusEvent) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;

  constructor(options: WebSocketServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (!this.client.isConnected) {
      this.logger.warn("Cannot start WebSocket: client not connected");
      return;
    }

    this.shouldReconnect = this.config.autoReconnect ?? true;
    await this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;
    this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;

    try {
      const wsUrl = this.client.getWebSocketUrl();
      const clawId = this.client.currentClawId;

      if (!clawId) {
        this.logger.error("No claw ID available for WebSocket connection");
        return;
      }

      this.logger.info(`Connecting to WebSocket: ${wsUrl}/ws/${clawId}`);

      this.ws = new WebSocket(`${wsUrl}/ws/${clawId}`);

      this.ws.onopen = () => {
        this.logger.info("WebSocket connected");
        this.isConnecting = false;
        this.subscribe();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);

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
          this.logger.debug("WebSocket event:", busEvent.event_type);
          this.onEvent?.(busEvent);
        } catch (error) {
          this.logger.error("Failed to parse WebSocket message:", error);
        }
      };

      this.ws.onerror = (error) => {
        this.logger.error("WebSocket error:", error);
      };

      this.ws.onclose = () => {
        this.logger.info("WebSocket disconnected");
        this.isConnecting = false;
        this.ws = null;
        this.scheduleReconnect();
      };
    } catch (error) {
      this.logger.error("Failed to connect WebSocket:", error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
        exclude_superseded: true,
      },
    };

    this.logger.debug("Subscribing with filter:", subscribeRequest.filter);
    this.ws.send(JSON.stringify(subscribeRequest));
  }

  sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ action: "heartbeat" }));
  }

  updateFilter(filter: WebSocketSubscribeRequest["filter"]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ action: "update_filter", filter }));
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const interval = this.config.reconnectInterval ?? 5000;
    this.logger.info(`Reconnecting in ${interval}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, interval);
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
