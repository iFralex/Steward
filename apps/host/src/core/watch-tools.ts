import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WatchRule } from "@steward/watch-engine";
import { sharedWatchEngine } from "./watch-runtime.ts";

export function buildWatchTools(chatId: string): ToolDefinition[] {
  return [createWatchTool(chatId, false), createWatchTool(chatId, true), stopWatchTool()];
}

const WATCH_AUTHORIZED_TOOLS = new Set(["mcp__voice__call_start"]);

function createWatchTool(chatId: string, agentWatch: boolean): ToolDefinition {
  return {
    name: agentWatch ? "create_agent_watch" : "create_watch",
    label: agentWatch ? "create_agent_watch" : "create_watch",
    description: agentWatch
      ? "Create a persistent event watch that resumes this same conversation when an event occurs and may use only the explicitly pre-authorized tools. This operation requires user approval. Use authorizedTools=['mcp__voice__call_start'] when the user explicitly asks to be called; the resumed agent can still use normal read-only tools such as train_status during the call. " + watchDomainDescription()
      : "Create a persistent, read-only event watch that resumes this same conversation and sends its response by PWA push. It cannot perform side effects. " + watchDomainDescription(),
    parameters: watchParameters(agentWatch),
    prepareArguments: (args: unknown) => args as never,
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const expiresAt = typeof params.expiresAt === "string" ? Date.parse(params.expiresAt) : undefined;
        if (expiresAt !== undefined && Number.isNaN(expiresAt)) throw new Error("expiresAt must be an ISO 8601 date-time");
        const authorizedTools = agentWatch ? parseAuthorizedTools(params.authorizedTools) : [];
        const watch = await sharedWatchEngine().create({
          source: required(params, "source"), resourceRef: required(params, "resourceRef"),
          rules: parseRules(params.rules), instruction: required(params, "instruction"), chatId,
          ...(authorizedTools.length ? { authorizedTools } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        return result({ watchId: watch.id, status: watch.status, source: watch.source, expiresAt: new Date(watch.expiresAt).toISOString(), rules: watch.rules, authorizedTools: watch.authorizedTools ?? [] });
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  } as ToolDefinition;
}

function watchDomainDescription(): string {
  return (
      "Currently source='train' is supported. Train events: train.platform_announced, train.platform_confirmed, train.platform_changed, train.departed, train.stop_arrived, train.stop_departed, train.delay_changed, train.cancelled, train.arrived. " +
      "If a scheduled-only platform is already present, watch train.platform_confirmed and train.platform_changed rather than platform_announced. " +
      "For stop events, where.positionRelativeToDestination=-1 means the stop immediately before the user's destination and 0 means the destination. Use once=true for one-shot milestones."
  );
}

function watchParameters(agentWatch: boolean): ToolDefinition["parameters"] {
  return {
      type: "object",
      properties: {
        source: { type: "string", description: "Watch adapter name; currently train." },
        resourceRef: { type: "string", description: "Opaque resource reference; for trains use trainRef from find_next_train." },
        rules: { type: "array", items: { type: "object", properties: {
          id: { type: "string", description: "Unique short id within this watch." },
          event: { type: "string", description: "Domain event name." },
          where: { type: "object", additionalProperties: true, description: "Optional equality filters over event data." },
          once: { type: "boolean", description: "Fire this rule only once." },
        }, required: ["id", "event"], additionalProperties: false } },
        instruction: { type: "string", description: "The user's notification preference, preserved for the future agent turn." },
        ...(agentWatch ? { authorizedTools: { type: "array", items: { type: "string" }, description: "Tools explicitly authorized for the future event turn. Currently only mcp__voice__call_start." } } : {}),
        expiresAt: { type: "string", description: "Optional ISO 8601 expiry; the adapter otherwise chooses a safe default." },
      },
      required: agentWatch ? ["source", "resourceRef", "rules", "instruction", "authorizedTools"] : ["source", "resourceRef", "rules", "instruction"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"];
}

function stopWatchTool(): ToolDefinition {
  return {
    name: "stop_watch", label: "stop_watch",
    description: "Stop a persistent read-only watch by watchId. Runs automatically because it only reduces background activity.",
    parameters: { type: "object", properties: { watchId: { type: "string" } }, required: ["watchId"], additionalProperties: false } as unknown as ToolDefinition["parameters"],
    prepareArguments: (args: unknown) => args as never,
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const watch = sharedWatchEngine().stop(required(params, "watchId"));
        return result({ watchId: watch.id, status: watch.status, stopped: watch.status === "stopped" });
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  } as ToolDefinition;
}

function required(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
function parseRules(value: unknown): WatchRule[] {
  if (!Array.isArray(value)) throw new Error("rules must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each rule must be an object");
    const row = item as Record<string, unknown>;
    return {
      id: required(row, "id"), event: required(row, "event"),
      ...(row.where && typeof row.where === "object" && !Array.isArray(row.where) ? { where: row.where as Record<string, unknown> } : {}),
      ...(row.once === true ? { once: true } : {}),
    };
  });
}
function parseAuthorizedTools(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("authorizedTools must contain at least one tool");
  const tools = [...new Set(value.map((tool) => typeof tool === "string" ? tool.trim() : ""))];
  if (tools.some((tool) => !WATCH_AUTHORIZED_TOOLS.has(tool))) {
    throw new Error(`Unsupported watch authorization. Allowed: ${[...WATCH_AUTHORIZED_TOOLS].join(", ")}`);
  }
  return tools;
}
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
