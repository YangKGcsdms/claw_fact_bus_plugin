/**
 * Fallback when @types/ws is not installed (optional peer); dynamic import in websocket.ts.
 */
declare module "ws" {
  const WebSocket: typeof globalThis.WebSocket;
  export default WebSocket;
}
