/**
 * Tool gating policy — the security core. The agent can only *request* a
 * tool; whether it *executes* is decided here (consulted by the
 * permission gate, which bridges the Agent SDK's permission callback to
 * the approval protocol). This is deterministic and independent of the
 * model's output, so a hallucinated sensitive call cannot fire without
 * an explicit user approval.
 *
 * Design: **default-deny** — anything not explicitly allowed is gated
 * (requires confirmation). Read-only / safe tools are allow-listed.
 * Tier by reversibility: read-only → allow; side-effecting / hard to
 * reverse → gate.
 */

export type ToolDecision = "allow" | "gate";

export interface ToolPolicy {
  /** Decision for any tool not matched by an explicit rule. */
  default: ToolDecision;
  /** Exact tool-name → decision overrides. */
  rules: Record<string, ToolDecision>;
}

/** Decide whether a tool call runs automatically or must be confirmed. */
export function decideTool(policy: ToolPolicy, toolName: string): ToolDecision {
  return policy.rules[toolName] ?? policy.default;
}

/**
 * Phase 1 default policy. Default-deny; allow-list the known read-only
 * tools (Agent SDK built-ins + LLM Wiki MCP read tools). MCP tools are
 * named `mcp__<server>__<tool>` by the Agent SDK; the LLM Wiki MCP
 * server is registered under the name `llm-wiki` (see agent-runner).
 *
 * Side-effecting tools (Bash, Write, Edit, llm_wiki_add_source, the
 * demo send_email tool, …) fall through to the `gate` default.
 */
export const defaultPolicy: ToolPolicy = {
  default: "gate",
  rules: {
    // Agent SDK built-ins — read-only.
    WebSearch: "allow",
    WebFetch: "allow",
    Read: "allow",
    Glob: "allow",
    Grep: "allow",
    // Internal tool discovery (no side effects).
    ToolSearch: "allow",
    // LLM Wiki MCP — read-only (the wiki as memory).
    "mcp__llm-wiki__llm_wiki_status": "allow",
    "mcp__llm-wiki__llm_wiki_projects": "allow",
    "mcp__llm-wiki__llm_wiki_files": "allow",
    "mcp__llm-wiki__llm_wiki_read_file": "allow",
    "mcp__llm-wiki__llm_wiki_search": "allow",
    "mcp__llm-wiki__llm_wiki_graph": "allow",
    "mcp__llm-wiki__llm_wiki_reviews": "allow",
    // Mail MCP — read-only (send_email / reply stay gated by default-deny).
    "mcp__mail__list_mailboxes": "allow",
    "mcp__mail__search_messages": "allow",
    "mcp__mail__read_message": "allow",
    "mcp__mail__save_attachment": "allow",
  },
};
