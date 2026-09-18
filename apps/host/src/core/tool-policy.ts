/**
 * Tool gating policy — the security core. The agent can only *request* a
 * tool; whether it *executes* is decided here (consulted by the permission
 * gate, which wraps each Pi tool's execute). This is deterministic and
 * independent of the model's output, so a hallucinated sensitive call cannot
 * fire without an explicit user approval.
 *
 * Design: **default-deny** — anything not explicitly allowed is gated
 * (requires confirmation). Read-only / safe tools are allow-listed.
 * Tier by reversibility: read-only → allow; side-effecting / hard to
 * reverse → gate.
 */

export type ToolDecision = "allow" | "gate" | "deny";

export interface ToolPolicy {
  /** Decision for any tool not matched by an explicit rule. */
  default: ToolDecision;
  /** Exact tool-name → decision overrides. */
  rules: Record<string, ToolDecision>;
  /**
   * Tool-name prefixes that are hard-denied (no user prompt). Defense in
   * depth against account-level connectors that aren't part of the host's
   * own MCP wiring (e.g. the Claude.ai Gmail/Google connectors) — we want
   * email to go through Apple Mail (mcp__mail__*) only. Explicit `rules`
   * win over this.
   */
  denyPrefixes?: string[];
}

/**
 * Decide whether a tool call runs automatically (`allow`), must be confirmed
 * (`gate`), or is rejected outright without asking the user (`deny`). Explicit
 * rules take precedence, then deny-prefixes, then the default.
 */
export function decideTool(policy: ToolPolicy, toolName: string): ToolDecision {
  const explicit = policy.rules[toolName];
  if (explicit) return explicit;
  if (policy.denyPrefixes?.some((p) => toolName.startsWith(p))) return "deny";
  return policy.default;
}

/**
 * Default policy. Default-deny; allow-list the known read-only tools.
 * The host runs Pi (`@earendil-works/pi-coding-agent`) with no builtin
 * tools (`noTools: "builtin"`) — every tool is a custom tool bridged from
 * an MCP server, named `mcp__<server>__<tool>`. The LLM Wiki MCP server
 * is registered under the name `llm-wiki` (see agent-runner).
 *
 * Side-effecting tools (llm_wiki_add_source, send_email, …) fall through
 * to the `gate` default.
 */
export const defaultPolicy: ToolPolicy = {
  default: "gate",
  // Block account-level connectors that aren't part of the host's own MCP
  // wiring (e.g. Claude.ai Gmail/Google connectors). Email goes through
  // Apple Mail only.
  denyPrefixes: ["mcp__claude_ai_", "mcp__plugin_"],
  rules: {
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
    "mcp__mail__get_thread": "allow",
    "mcp__mail__save_attachment": "allow",
    "mcp__mail__list_scheduled": "allow", // read-only (send/reply/cancel_scheduled stay gated)
    // Calendar MCP — read-only (create/update/delete stay gated by default-deny).
    "mcp__calendar__list_calendars": "allow",
    "mcp__calendar__search_events": "allow",
    "mcp__calendar__read_event": "allow",
    // Contacts MCP — read-only (create/update stay gated by default-deny).
    "mcp__contacts__search_contacts": "allow",
    "mcp__contacts__read_contact": "allow",
    "mcp__contacts__resolve_recipient": "allow",
    // Action Center MCP — read-only listing/reading is safe. mark_action falls
    // through to gated default because it changes item state.
    "mcp__action-center__list_actions": "allow",
    "mcp__action-center__read_action": "allow",
    "mcp__action-center__list_flows": "allow",
    "mcp__action-center__search_flows": "allow",
    // Shell MCP — read-only search/inspection runs freely; the mutating
    // run_write_command falls through to the gated default (needs approval).
    "mcp__shell__find_files": "allow",
    "mcp__shell__run_command": "allow",
    // Trains MCP — live lookups are read-only. Persistent watch creation and
    // removal intentionally fall through to the gated default.
    "mcp__trains__find_next_train": "allow",
    "mcp__trains__train_status": "allow",
  },
};
