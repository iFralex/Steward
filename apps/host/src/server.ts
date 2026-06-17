/**
 * WebSocket server — the transport for the channel protocol. Each
 * connection is one session (one channel client: the web UI in Phase 1;
 * Telegram/Discord later are just more clients of the same protocol).
 */
import { WebSocketServer } from "ws";
import type { ClientEvent } from "@llm-wiki/protocol";
import { runTurn } from "./core/agent-runner.ts";
import { Session, type Emit } from "./core/session.ts";
import type { HostConfig } from "./config.ts";

export function startServer(config: HostConfig): WebSocketServer {
  const wss = new WebSocketServer({ port: config.port, host: "127.0.0.1" });

  wss.on("connection", (ws) => {
    const emit: Emit = (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const session = new Session(emit, config.approvalTimeoutMs);
    emit({ type: "status", sessionId: session.id, state: "idle" });

    ws.on("message", (data) => {
      let msg: ClientEvent;
      try {
        msg = JSON.parse(data.toString()) as ClientEvent;
      } catch {
        emit({ type: "error", message: "invalid JSON" });
        return;
      }
      switch (msg.type) {
        case "user_message":
          void runTurn(config, session, emit, msg.text);
          break;
        case "approval_decision":
          session.resolveApproval(msg.requestId, { decision: msg.decision, note: msg.note });
          break;
      }
    });
  });

  console.log(`[host] WebSocket listening on ws://127.0.0.1:${config.port}`);
  return wss;
}
