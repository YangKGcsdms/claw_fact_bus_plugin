/**
 * FIFO buffer for WebSocket bus events consumed by fact_bus_sense.
 */

import type { BusEvent } from "./types.js";

const MAX_PENDING = 100;

export const pendingEvents: BusEvent[] = [];

/** Events dropped due to queue overflow since last fact_bus_sense drain. */
let droppedSinceLastSense = 0;

export function pushPendingEvent(
  event: BusEvent,
  onOverflow?: (droppedInThisPush: number) => void
): void {
  pendingEvents.push(event);
  let droppedInThisPush = 0;
  while (pendingEvents.length > MAX_PENDING) {
    pendingEvents.shift();
    droppedSinceLastSense++;
    droppedInThisPush++;
  }
  if (droppedInThisPush > 0) {
    onOverflow?.(droppedInThisPush);
  }
}

/** Returns overflow drops since last call, then resets the counter. */
export function consumeDroppedPendingCount(): number {
  const n = droppedSinceLastSense;
  droppedSinceLastSense = 0;
  return n;
}

export { MAX_PENDING };
