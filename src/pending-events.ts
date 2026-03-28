/**
 * FIFO buffer for WebSocket bus events consumed by fact_bus_sense.
 */

import type { BusEvent } from "./types.js";

const MAX_PENDING = 100;

export const pendingEvents: BusEvent[] = [];

export function pushPendingEvent(event: BusEvent): void {
  pendingEvents.push(event);
  while (pendingEvents.length > MAX_PENDING) {
    pendingEvents.shift();
  }
}
