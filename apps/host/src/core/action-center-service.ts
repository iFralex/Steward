import type {
  ActionCenterDiagnostics,
  ActionCenterItem,
  ActionCenterState,
  ActionStatus,
  ServerEvent,
} from "@llm-wiki/protocol";
import { ActionStore } from "../../../action-center/src/store.ts";
import { actionDbPath } from "../../../action-center/src/paths.ts";
import type { HostConfig } from "../config.ts";
import { buildMcpBridge } from "@llm-wiki/mcp-bridge";
import type { Emit, Session } from "./session.ts";
import { decideTool } from "./tool-policy.ts";

interface ProposedStep {
  id: string;
  label: string;
  tool: string;
  input: Record<string, unknown>;
  writes: boolean;
}

interface ProposedAction {
  id: string;
  label: string;
  summary: string;
  steps: ProposedStep[];
}

export function loadActionCenterState(opts: { includeDone?: boolean; limit?: number } = {}): ActionCenterState {
  const store = ActionStore.open(actionDbPath());
  try {
    const items = store.list({ includeDone: opts.includeDone, limit: opts.limit ?? 50 }) as ActionCenterItem[];
    const all = store.list({ includeDone: true, limit: 1000 }) as ActionCenterItem[];
    return { items, diagnostics: diagnostics(store, all) };
  } finally {
    store.close();
  }
}

export function markAction(id: number, status: ActionStatus): ActionCenterState {
  const store = ActionStore.open(actionDbPath());
  try {
    store.mark(id, status);
  } finally {
    store.close();
  }
  return loadActionCenterState();
}

export async function executeActionProposal(args: {
  config: HostConfig;
  session: Session;
  emit: Emit;
  actionId: number;
  proposalId: string;
}): Promise<ActionCenterState> {
  const action = loadAction(args.actionId);
  if (!action) throw new Error(`Action not found: ${args.actionId}`);
  const proposal = findProposal(action, args.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposalId}`);
  const bridge = await ensureDirectBridge(args.config, args.session);

  for (const step of proposal.steps) {
    const decision = decideTool(args.config.policy, step.tool);
    if (decision === "deny") throw new Error(`Tool denied by policy: ${step.tool}`);

    let input = step.input ?? {};
    if (decision === "gate") {
      const approved = await args.session.requestApproval({ tool: step.tool, input });
      if (approved.decision !== "allow") {
        args.emit({ type: "tool_result", sessionId: args.session.id, tool: step.tool, ok: false, summary: approved.note ?? "Denied" });
        throw new Error(`Action execution stopped: ${step.label}`);
      }
      input = approved.editedInput ?? input;
    }

    args.emit({ type: "tool_call", sessionId: args.session.id, tool: step.tool, input });
    const result = await bridge.callTool(step.tool, input);
    args.emit({ type: "tool_result", sessionId: args.session.id, tool: step.tool, ok: true, summary: summarizeToolResult(result) });
  }

  return markAction(args.actionId, "done");
}

async function ensureDirectBridge(config: HostConfig, session: Session) {
  if (!session.directBridge) session.directBridge = await buildMcpBridge(config.mcpServers);
  return session.directBridge;
}

function loadAction(id: number): ActionCenterItem | null {
  const store = ActionStore.open(actionDbPath());
  try {
    return ((store.list({ includeDone: true, limit: 1000 }) as ActionCenterItem[]).find((a) => a.id === id) ?? null);
  } finally {
    store.close();
  }
}

function findProposal(action: ActionCenterItem, proposalId: string): ProposedAction | null {
  const value = action.payload.proposedActions;
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const p = candidate as Record<string, unknown>;
    if (p.id !== proposalId || !Array.isArray(p.steps)) continue;
    const steps = p.steps
      .map((raw) => normalizeStep(raw))
      .filter((s): s is ProposedStep => !!s);
    if (!steps.length) return null;
    return {
      id: String(p.id),
      label: typeof p.label === "string" ? p.label : String(p.id),
      summary: typeof p.summary === "string" ? p.summary : "",
      steps,
    };
  }
  return null;
}

function normalizeStep(raw: unknown): ProposedStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.tool !== "string") return null;
  return {
    id: typeof s.id === "string" ? s.id : s.tool,
    label: typeof s.label === "string" ? s.label : s.tool,
    tool: s.tool,
    input: s.input && typeof s.input === "object" && !Array.isArray(s.input) ? s.input as Record<string, unknown> : {},
    writes: s.writes !== false,
  };
}

function diagnostics(store: ActionStore, all: ActionCenterItem[]): ActionCenterDiagnostics {
  const byKind: Record<string, number> = {};
  for (const item of all) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  const now = Math.floor(Date.now() / 1000);
  const active = all.filter((a) => a.status === "new" || a.status === "read");
  const nextDueAt = active.map((a) => a.dueAt).filter((v): v is number => typeof v === "number").sort((a, b) => a - b)[0] ?? null;
  const lastUpdatedAt = all.map((a) => a.updatedAt).sort((a, b) => b - a)[0] ?? null;
  const lastScan = store.getMeta<{ result?: { mail?: { deferredReasons?: Record<string, number> } } }>("lastScan");
  return {
    counts: store.counts(),
    byKind,
    staleNew: active.filter((a) => a.status === "new" && now - a.updatedAt > 3 * 86400).length,
    nextDueAt,
    lastUpdatedAt,
    deferredReasons: lastScan?.result?.mail?.deferredReasons,
  };
}

function summarizeToolResult(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return String(result);
  }
}
