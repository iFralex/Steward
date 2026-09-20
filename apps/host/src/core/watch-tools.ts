import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WatchRule, WatchToolGrant } from "@steward/watch-engine";
import { sharedWatchEngine } from "./watch-runtime.ts";

export function buildWatchTools(chatId: string): ToolDefinition[] {
  return [createWatchTool(chatId, false), createWatchTool(chatId, true), stopWatchTool()];
}

function createWatchTool(chatId: string, agentWatch: boolean): ToolDefinition {
  return {
    name: agentWatch ? "create_agent_watch" : "create_watch",
    label: agentWatch ? "create_agent_watch" : "create_watch",
    description: agentWatch
      ? "Create a persistent event watch that resumes this same conversation. Side-effecting capabilities are approved per rule in grants and enforced against exact constraints. This operation requires user approval. Use a voice grant to call, or a mail grant with an exact recipient, subject and body template. Read-only tools remain available. " + watchDomainDescription()
      : "Create a persistent, read-only event watch that resumes this same conversation and sends its response by PWA push. It cannot perform side effects. " + watchDomainDescription(),
    parameters: watchParameters(agentWatch),
    prepareArguments: (args: unknown) => args as never,
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const expiresAt = typeof params.expiresAt === "string" ? Date.parse(params.expiresAt) : undefined;
        if (expiresAt !== undefined && Number.isNaN(expiresAt)) throw new Error("expiresAt must be an ISO 8601 date-time");
        const rules = parseRules(params.rules, agentWatch);
        if (agentWatch && !rules.some((rule) => rule.grants?.length)) throw new Error("An agent watch requires at least one rule-scoped grant");
        const watch = await sharedWatchEngine().create({
          source: required(params, "source"), resourceRef: required(params, "resourceRef"),
          rules, instruction: required(params, "instruction"), chatId,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        return result({ watchId: watch.id, status: watch.status, source: watch.source, expiresAt: new Date(watch.expiresAt).toISOString(), rules: watch.rules });
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
      + " For a time-relative milestone use trigger={kind:'before_time',field:'estimatedArrivalMs',minutes:30}; it follows live ETA changes and fires on the first poll inside the window."
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
          trigger: { type: "object", properties: {
            kind: { type: "string", enum: ["before_time"] },
            field: { type: "string", description: "Dot path to a timestamp in the live snapshot; trains expose estimatedArrivalMs." },
            minutes: { type: "number", minimum: 0 },
          }, required: ["kind", "field", "minutes"], additionalProperties: false },
          where: { type: "object", additionalProperties: true, description: "Optional equality filters over event data." },
          once: { type: "boolean", description: "Fire this rule only once." },
          ...(agentWatch ? { grants: { type: "array", items: { type: "object", properties: {
            tool: { type: "string", enum: ["mcp__voice__call_start", "mcp__mail__send_email"] },
            maxInvocations: { type: "number", enum: [1] },
            constraints: { type: "object", properties: {
              to: { type: "array", items: { type: "string" }, minItems: 1 },
              subject: { type: "string" },
              bodyTemplate: { type: "string", description: "Exact plain-text body. Supports {{estimatedArrival}}, {{delayMinutes}}, {{destination}}, and {{trainNumber}}." },
            }, required: ["to", "subject", "bodyTemplate"], additionalProperties: false },
          }, required: ["tool"], additionalProperties: false } } } : {}),
        }, required: ["id"], additionalProperties: false } },
        instruction: { type: "string", description: "The user's notification preference, preserved for the future agent turn." },
        expiresAt: { type: "string", description: "Optional ISO 8601 expiry; the adapter otherwise chooses a safe default." },
      },
      required: ["source", "resourceRef", "rules", "instruction"],
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
function parseRules(value: unknown, allowGrants: boolean): WatchRule[] {
  if (!Array.isArray(value)) throw new Error("rules must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each rule must be an object");
    const row = item as Record<string, unknown>;
    const event = typeof row.event === "string" && row.event.trim() ? row.event.trim() : undefined;
    const trigger = parseTrigger(row.trigger);
    if (Number(!!event) + Number(!!trigger) !== 1) throw new Error("Each rule needs exactly one of event or trigger");
    if (!allowGrants && row.grants !== undefined) throw new Error("Rule grants require create_agent_watch");
    const grants = allowGrants ? parseGrants(row.grants) : [];
    if (grants.length && row.once !== true) throw new Error("Rules with side-effect grants must set once=true");
    return {
      id: required(row, "id"), ...(event ? { event } : {}), ...(trigger ? { trigger } : {}),
      ...(row.where && typeof row.where === "object" && !Array.isArray(row.where) ? { where: row.where as Record<string, unknown> } : {}),
      ...(row.once === true ? { once: true } : {}),
      ...(grants.length ? { grants } : {}),
    };
  });
}

function parseTrigger(value: unknown): WatchRule["trigger"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trigger must be an object");
  const row = value as Record<string, unknown>;
  if (row.kind !== "before_time" || typeof row.field !== "string" || !row.field.trim()
    || typeof row.minutes !== "number" || !Number.isFinite(row.minutes) || row.minutes < 0) throw new Error("Invalid before_time trigger");
  return { kind: "before_time", field: row.field.trim(), minutes: row.minutes };
}

function parseGrants(value: unknown): WatchToolGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("grants must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each grant must be an object");
    const row = item as Record<string, unknown>;
    if (row.maxInvocations !== undefined && row.maxInvocations !== 1) throw new Error("Watch grants permit exactly one invocation");
    if (row.tool === "mcp__voice__call_start") return { tool: row.tool, maxInvocations: 1 };
    if (row.tool !== "mcp__mail__send_email") throw new Error("Unsupported watch grant tool");
    const constraints = row.constraints;
    if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) throw new Error("Email grants require constraints");
    const fields = constraints as Record<string, unknown>;
    if (!Array.isArray(fields.to) || !fields.to.length || fields.to.some((entry) => typeof entry !== "string" || !entry.includes("@"))) throw new Error("Email grant requires exact recipient addresses");
    const subject = required(fields, "subject");
    const bodyTemplate = required(fields, "bodyTemplate");
    return { tool: row.tool, maxInvocations: 1, constraints: { to: fields.to.map((entry) => String(entry).trim()), subject, bodyTemplate } };
  });
}
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
