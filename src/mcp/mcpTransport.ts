/**
 * Transport interface shared by every MCP transport (stdio, Streamable HTTP).
 *
 * Hides the wire-level differences from `McpClient`: the client talks JSON-RPC
 * messages and lets the transport handle framing, network, and lifecycle.
 */

import type { JsonRpcMessage } from "./mcpTypes.js";

export interface McpTransportHandlers {
  /** Called for every JSON-RPC message received from the server. */
  onMessage: (message: JsonRpcMessage) => void;
  /** Called when the underlying transport closes (process exit, socket close). */
  onClose: (reason: string | null) => void;
  /** Called for transport-level errors that don't necessarily close it. */
  onError?: (error: Error) => void;
  /** Called for stderr lines (stdio only); ignored by other transports. */
  onStderr?: (line: string) => void;
}

export interface McpTransport {
  /** Open the transport and begin pumping messages into `handlers.onMessage`. */
  start(handlers: McpTransportHandlers): Promise<void>;
  /** Send a single JSON-RPC message to the server. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Close the transport. Idempotent. */
  close(): Promise<void>;
  /** True if `start()` has resolved and `close()` hasn't been called. */
  isOpen(): boolean;
}
