import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WatchRule } from "@steward/watch-engine";
import { sharedWatchEngine } from "./watch-runtime.ts";

export function buildWatchTools(chatId: string): ToolDefinition[] {
  return [createWatchTool(chatId), stopWatchTool()];
}

function createWatchTool(chatId: string): ToolDefinition {
  return {
    name: "create_watch",
    label: "create_watch",
    description:
      "Create a persistent, read-only event watch that returns future matching events to Steward, which writes an accessible notification and sends it by PWA push. " +
      "Currently source='train' is supported. Train events: train.platform_announced, train.platform_confirmed, train.platform_changed, train.departed, train.stop_arrived, train.stop_departed, train.delay_changed, train.cancelled, train.arrived. " +
      "If a scheduled-only platform is already present, watch train.platform_confirmed and train.platform_changed rather than platform_announced. " +
      "For stop events, where.positionRelativeToDestination=-1 means the stop immediately before the user's destination and 0 means the destination. Use once=true for one-shot milestones. " +
      "This tool only observes and notifies; it cannot perform sensitive actions, so it runs automatically.",
    parameters: {
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
        expiresAt: { type: "string", description: "Optional ISO 8601 expiry; the adapter otherwise chooses a safe default." },
      },
      required: ["source", "resourceRef", "rules", "instruction"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    prepareArguments: (args: unknown) => args as never,
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const expiresAt = typeof params.expiresAt === "string" ? Date.parse(params.expiresAt) : undefined;
        if (expiresAt !== undefined && Number.isNaN(expiresAt)) throw new Error("expiresAt must be an ISO 8601 date-time");
        const watch = await sharedWatchEngine().create({
          source: required(params, "source"), resourceRef: required(params, "resourceRef"),
          rules: parseRules(params.rules), instruction: required(params, "instruction"), chatId,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        return result({ watchId: watch.id, status: watch.status, source: watch.source, expiresAt: new Date(watch.expiresAt).toISOString(), rules: watch.rules });
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  } as ToolDefinition;
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
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
