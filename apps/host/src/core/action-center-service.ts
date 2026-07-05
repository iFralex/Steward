import type {
  ActionCenterDiagnostics,
  ActionCenterItem,
  ActionCenterState,
  ActionStatus,
  PersistedMessage,
  ServerEvent,
} from "@steward/protocol";
import { chatStore, toolMessage } from "./chat-store.ts";
import { randomUUID } from "node:crypto";
import { ActionStore } from "../../../action-center/src/store.ts";
import { actionDbPath } from "../../../action-center/src/paths.ts";
import { gatewayChat, jsonFromLlm } from "../../../action-center/src/llm.ts";
import type { HostConfig } from "../config.ts";
import type { Emit, Session } from "./session.ts";
import { decideTool } from "./tool-policy.ts";
import { extractToolOutput, sharedMcpBridge } from "./agent-runner.ts";
import { filesFromOutput } from "./file-registry.ts";
import type { PushRegistry } from "./push.ts";

/**
 * Push registry for the action-center → phone hook (mobile-access M2/M3), set
 * once at server startup. Kept as an injectable module-level singleton rather
 * than threaded through every `loadActionCenterState()` call site (there are
 * several, none of which otherwise need host config); `null` in tests/CLI
 * contexts where it's never set, in which case the hook is a no-op.
 */
let pushRegistry: PushRegistry | null = null;
export function setPushRegistry(registry: PushRegistry | null): void {
  pushRegistry = registry;
}

/** Meta key: ids of "new" action-center items we've already pushed a notification for. */
const PUSH_NOTIFIED_META_KEY = "pushNotifiedIds";

/**
 * Best-effort: push a notification for every item that just became visible
 * with status "new" and at least one proposed action, and that we haven't
 * already notified for. Never throws — a push failure must never break the
 * action-center read/refresh/mark/execute flow that calls this.
 */
function notifyNewProposals(store: ActionStore, items: ActionCenterItem[]): void {
  if (!pushRegistry) return;
  try {
    const notified = new Set(store.getMeta<number[]>(PUSH_NOTIFIED_META_KEY) ?? []);
    const stillNew = new Set(items.filter((i) => i.status === "new").map((i) => i.id));
    let changed = false;
    for (const id of notified) {
      if (!stillNew.has(id)) {
        notified.delete(id); // left "new" (read/done/dismissed) — allow re-notifying if it ever reopens
        changed = true;
      }
    }
    for (const item of items) {
      if (item.status !== "new" || notified.has(item.id)) continue;
      const proposals = item.payload.proposedActions;
      if (!Array.isArray(proposals) || proposals.length === 0) continue;
      notified.add(item.id);
      changed = true;
      void pushRegistry.sendAll({
        title: "Steward",
        body: item.title || item.summary || "Nuova proposta da approvare",
        tag: `action-${item.id}`,
        actionId: item.id,
        type: "approval",
      }).catch(() => { /* best-effort — never break the caller */ });
    }
    if (changed) store.setMeta(PUSH_NOTIFIED_META_KEY, [...notified]);
  } catch {
    /* best-effort — never break the caller */
  }
}

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
  confidence?: "low" | "medium" | "high";
  steps: ProposedStep[];
}

const REVISE_PROPOSAL_SYSTEM = `You revise exactly one saved Action Center proposed action.
Return ONLY JSON:
{"proposal":{"id": string, "label": string, "summary": string, "confidence": "low"|"medium"|"high",
"steps":[{"id": string, "label": string, "tool": string, "input": object, "writes": boolean}]}}.
Rules:
- Revise only the selected proposal according to the user's instruction.
- Preserve the same proposal id.
- Preserve executable write-tool steps unless the instruction requires changing the tool.
- Do not execute anything.
- Do not include read-only gathering steps.
- Tool inputs must be ready for approval/execution.`;

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
  /** When set, the execution transcript is persisted into this chat. */
  chatId?: string;
}): Promise<ActionCenterState> {
  const action = loadAction(args.actionId);
  if (!action) throw new Error(`Action not found: ${args.actionId}`);
  const proposal = findProposal(action, args.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposalId}`);
  const bridge = await ensureDirectBridge(args.config);
  const record = (msg: PersistedMessage) => { if (args.chatId) chatStore().addMessage(args.chatId, msg); };
  record({ id: randomUUID(), role: "user", text: `Esegui: ${proposal.label}` });

  for (const step of proposal.steps) {
    const decision = decideTool(args.config.policy, step.tool);
    if (decision === "deny") throw new Error(`Tool denied by policy: ${step.tool}`);

    let input = step.input ?? {};
    if (decision === "gate") {
      const approved = await args.session.requestApproval({ tool: step.tool, input, chatId: args.chatId });
      if (approved.decision === "revise") {
        throw new ActionRevisionRequestedError(buildRevisionPrompt(action, proposal, step, approved.note));
      }
      if (approved.decision !== "allow") {
        throw new Error(`Action execution stopped: ${step.label}`);
      }
      input = approved.editedInput ?? input;
    }

    const toolCallId = randomUUID();
    args.emit({ type: "tool_call", sessionId: args.session.id, toolCallId, tool: step.tool, input, ...(args.chatId ? { chatId: args.chatId } : {}) });
    const startedAt = Date.now();
    try {
      const result = await bridge.callTool(step.tool, input);
      const output = extractToolOutput(result);
      const files = filesFromOutput(output);
      const durationMs = Date.now() - startedAt;
      args.emit({
        type: "tool_result", sessionId: args.session.id, toolCallId, tool: step.tool,
        ok: true, output, durationMs,
        ...(files.length ? { files } : {}),
        ...(args.chatId ? { chatId: args.chatId } : {}),
      });
      record(toolMessage({ tool: step.tool, input, toolCallId, ok: true, output, durationMs, files }));
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof Error ? err.message : String(err);
      args.emit({
        type: "tool_result", sessionId: args.session.id, toolCallId, tool: step.tool,
        ok: false, output: null, durationMs, error,
        ...(args.chatId ? { chatId: args.chatId } : {}),
      });
      record(toolMessage({ tool: step.tool, input, toolCallId, ok: false, output: null, durationMs, error }));
      throw err;
    }
  }

  record({ id: randomUUID(), role: "assistant", text: `✓ Proposta "${proposal.label}" eseguita.` });
  return markAction(args.actionId, "done");
}

export async function reviseActionProposal(args: {
  config: HostConfig;
  actionId: number;
  proposalId: string;
  instruction: string;
}): Promise<ActionCenterState> {
  const instruction = args.instruction.trim();
  if (!instruction) throw new Error("Revision instruction is required");
  const action = loadAction(args.actionId);
  if (!action) throw new Error(`Action not found: ${args.actionId}`);
  const proposal = findProposal(action, args.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposalId}`);
  const chat = gatewayChat({
    endpoint: `${args.config.gateway.baseUrl.replace(/\/$/, "")}/chat/completions`,
    model: args.config.gateway.tier,
    apiKey: args.config.gateway.apiKey,
  });
  const raw = await chat(REVISE_PROPOSAL_SYSTEM, JSON.stringify({
    userInstruction: instruction,
    action: {
      id: action.id,
      title: action.title,
      summary: action.summary,
      kind: action.kind,
      priority: action.priority,
      payload: action.payload,
    },
    selectedProposal: proposal,
  }, null, 2));
  const parsed = jsonFromLlm<Record<string, unknown>>(raw);
  const revised = normalizeRevisedProposal(parsed?.proposal, proposal);
  if (!revised) throw new Error("Could not revise proposal");
  updateActionProposal(action, revised, instruction);
  return loadActionCenterState();
}

export class ActionRevisionRequestedError extends Error {
  constructor(readonly prompt: string) {
    super("Action revision requested");
  }
}

async function ensureDirectBridge(config: HostConfig) {
  return sharedMcpBridge(config.mcpServers);
}

export function getActionItem(id: number): ActionCenterItem | null {
  return loadAction(id);
}

function loadAction(id: number): ActionCenterItem | null {
  const store = ActionStore.open(actionDbPath());
  try {
    return (store.get(id) as ActionCenterItem | null) ?? null;
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
      confidence: p.confidence === "low" || p.confidence === "medium" || p.confidence === "high" ? p.confidence : undefined,
      steps,
    };
  }
  return null;
}

function normalizeRevisedProposal(value: unknown, original: ProposedAction): ProposedAction | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const steps = Array.isArray(obj.steps)
    ? obj.steps.map((raw) => normalizeStep(raw)).filter((s): s is ProposedStep => !!s)
    : [];
  if (!steps.length) return null;
  return {
    id: original.id,
    label: typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : original.label,
    summary: typeof obj.summary === "string" ? obj.summary : original.summary,
    confidence: obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high" ? obj.confidence : original.confidence,
    steps,
  };
}

function updateActionProposal(action: ActionCenterItem, revised: ProposedAction, instruction: string): void {
  const store = ActionStore.open(actionDbPath());
  try {
    const payload = { ...action.payload };
    const proposals = Array.isArray(payload.proposedActions) ? [...payload.proposedActions] : [];
    const index = proposals.findIndex((p) => p && typeof p === "object" && (p as Record<string, unknown>).id === revised.id);
    if (index < 0) throw new Error(`Proposal not found: ${revised.id}`);
    proposals[index] = revised;
    payload.proposedActions = proposals;
    const revisions = Array.isArray(payload.proposalRevisions) ? payload.proposalRevisions : [];
    payload.proposalRevisions = [
      ...revisions,
      { proposalId: revised.id, instruction, at: Math.floor(Date.now() / 1000) },
    ].slice(-20);
    store.raw.prepare("UPDATE actions SET payload=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(payload), Math.floor(Date.now() / 1000), action.id);
  } finally {
    store.close();
  }
}

function buildRevisionPrompt(
  action: ActionCenterItem,
  proposal: ProposedAction,
  step: ProposedStep,
  note?: string,
): string {
  return [
    `The user selected an Action Center proposal but requested a revision instead of approving the guarded write tool.`,
    `Action id: ${action.id}`,
    `Action title: ${action.title}`,
    `Action summary: ${action.summary}`,
    `Selected proposal: ${proposal.label} (${proposal.id})`,
    proposal.summary ? `Proposal summary: ${proposal.summary}` : "",
    `Blocked step: ${step.label} using ${step.tool}`,
    `Original tool input:\n${JSON.stringify(step.input, null, 2)}`,
    `User revision note:\n${note?.trim() || "(no note)"}`,
    "",
    "Read the action context below and produce the revised action. If the revision is clear and requires a write tool, call the corrected mail/calendar tool; the host will ask for approval again. If anything is ambiguous, ask a concise clarification.",
    `Action payload:\n${JSON.stringify(action.payload, null, 2)}`,
  ].filter(Boolean).join("\n\n");
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
