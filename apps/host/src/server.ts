/**
 * WebSocket server — the transport for the channel protocol. Each
 * connection is one session (one channel client: the web UI in Phase 1;
 * Telegram/Discord later are just more clients of the same protocol).
 */
import { WebSocketServer } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import type { ClientEvent } from "@llm-wiki/protocol";
import { runTurn } from "./core/agent-runner.ts";
import { ActionRevisionRequestedError, executeActionProposal, loadActionCenterState, markAction, reviseActionProposal } from "./core/action-center-service.ts";
import { resolveToken } from "./core/file-registry.ts";
import { Session, type Emit } from "./core/session.ts";
import type { HostConfig } from "./config.ts";

/** Serve a registered file by token: GET /file/<token>. Unknown tokens → 404. */
function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const m = (req.url ?? "").match(/^\/file\/([\w-]+)/);
  const entry = m ? resolveToken(m[1]) : null;
  if (!entry) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); res.end("not found"); return; }
  res.writeHead(200, {
    "Content-Type": entry.ref.mime,
    "Content-Length": entry.ref.size,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.ref.name)}`,
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
}

export function startServer(config: HostConfig): WebSocketServer {
  const httpServer = createServer(handleHttp);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    const emit: Emit = (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const session = new Session(emit, config.approvalTimeoutMs);
    emit({ type: "status", sessionId: session.id, state: "idle" });
    emit({ type: "action_center_state", sessionId: session.id, state: loadActionCenterState() });

    ws.on("close", () => {
      session.closed = true;
      void session.pi?.close();
      void session.directBridge?.close();
    });

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
          session.resolveApproval(msg.requestId, {
            decision: msg.decision,
            note: msg.note,
            editedInput: msg.editedInput,
          });
          break;
        case "question_response":
          session.resolveQuestion(msg.requestId, msg.selected);
          break;
        case "open_file": {
          const entry = resolveToken(msg.token);
          if (entry) execFile("/usr/bin/open", [entry.path], () => {});
          break;
        }
        case "reveal_file": {
          const entry = resolveToken(msg.token);
          if (entry) execFile("/usr/bin/open", ["-R", entry.path], () => {});
          break;
        }
        case "action_center_refresh":
          emit({
            type: "action_center_state",
            sessionId: session.id,
            state: loadActionCenterState({ includeDone: msg.includeDone, limit: msg.limit }),
          });
          break;
        case "action_center_mark":
          emit({ type: "action_center_state", sessionId: session.id, state: markAction(msg.id, msg.status) });
          break;
        case "action_center_execute":
          void (async () => {
            emit({ type: "status", sessionId: session.id, state: "running" });
            try {
              const state = await executeActionProposal({
                config,
                session,
                emit,
                actionId: msg.id,
                proposalId: msg.proposalId,
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              if (err instanceof ActionRevisionRequestedError) {
                await runTurn(config, session, emit, err.prompt);
              } else {
                emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
              }
            } finally {
              emit({ type: "status", sessionId: session.id, state: "idle" });
            }
          })();
          break;
        case "action_center_revise":
          void (async () => {
            emit({ type: "status", sessionId: session.id, state: "running" });
            try {
              const state = await reviseActionProposal({
                config,
                actionId: msg.id,
                proposalId: msg.proposalId,
                instruction: msg.instruction,
              });
              emit({ type: "action_center_state", sessionId: session.id, state });
            } catch (err) {
              emit({ type: "error", sessionId: session.id, message: err instanceof Error ? err.message : String(err) });
            } finally {
              emit({ type: "status", sessionId: session.id, state: "idle" });
            }
          })();
          break;
      }
    });
  });

  httpServer.listen(config.port, "127.0.0.1", () => {
    console.log(`[host] WebSocket listening on ws://127.0.0.1:${config.port} (files at http://127.0.0.1:${config.port}/file/<token>)`);
  });
  return wss;
}
