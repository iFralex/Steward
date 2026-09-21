import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WatchRule, WatchToolGrant } from "@steward/watch-engine";
import { sharedWatchEngine } from "./watch-runtime.ts";
import { parseWatchGrant, watchCapabilityNames } from "./watch-capabilities.ts";
import { createTimeResourceRef } from "./time-watch-adapter.ts";
import type { PreflightToolDefinition } from "./permission-gate.ts";

export function buildWatchTools(chatId: string): ToolDefinition[] {
  return [createWatchTool(chatId, false), createWatchTool(chatId, true), stopWatchTool()];
}

function createWatchTool(chatId: string, agentWatch: boolean): ToolDefinition {
  return {
    name: agentWatch ? "create_agent_watch" : "create_watch",
    label: agentWatch ? "create_agent_watch" : "create_watch",
    description: agentWatch
      ? `Create a persistent event watch that resumes this same conversation. Side-effecting capabilities are approved per rule and deterministically constrained. This operation requires user approval. Registered capabilities: ${watchCapabilityNames().join(", ")}. Constraint kinds are exact, template, one_of and numeric range. Templates reference trusted values such as {{state.estimatedArrival}} or {{event.data.station}}. Read-only tools remain available. ` + watchDomainDescription()
      : "Create a persistent, read-only event watch that resumes this same conversation and sends its response by PWA push. It cannot perform side effects. " + watchDomainDescription(),
    parameters: watchParameters(agentWatch),
    prepareArguments: (args: unknown) => args as never,
    preflightInput: (input: Record<string, unknown>) => prepareWatchInput(input, agentWatch),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const expiresAt = typeof params.expiresAt === "string" ? Date.parse(params.expiresAt) : undefined;
      const rules = parseRules(params.rules, agentWatch);
      const source = required(params, "source");
      const resourceRef = source === "time" ? timeResourceRef(params) : required(params, "resourceRef");
      const watch = await sharedWatchEngine().create({
        source, resourceRef,
        rules, instruction: required(params, "instruction"), chatId,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      return result({ watchId: watch.id, status: watch.status, source: watch.source, expiresAt: new Date(watch.expiresAt).toISOString(), rules: watch.rules });
    },
  } as PreflightToolDefinition;
}

/** Validate before approval and freeze relative time to the instant approval starts. */
function prepareWatchInput(input: Record<string, unknown>, agentWatch: boolean): Record<string, unknown> {
  const params = structuredClone(input);
  const expiresAt = typeof params.expiresAt === "string" ? Date.parse(params.expiresAt) : undefined;
  if (params.expiresAt !== undefined && (expiresAt === undefined || Number.isNaN(expiresAt))) {
    throw new Error("expiresAt must be an ISO 8601 date-time");
  }
  const rules = parseRules(params.rules, agentWatch);
  if (agentWatch && !rules.some((rule) => rule.grants?.length)) {
    throw new Error("An agent watch requires at least one rule-scoped grant");
  }
  const source = required(params, "source");
  if (source !== "time" && source !== "train") throw new Error("source must be 'time' or 'train'");
  if (source === "time") {
    const hasAfter = params.afterMinutes !== undefined;
    const hasAbsolute = params.at !== undefined;
    if (hasAfter === hasAbsolute) throw new Error("A time watch requires exactly one of afterMinutes or at");
    if (hasAfter) {
      const minutes = params.afterMinutes;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > 525_600) {
        throw new Error("afterMinutes must be greater than 0 and no more than 525600");
      }
      params.at = new Date(Date.now() + minutes * 60_000).toISOString();
      delete params.afterMinutes;
    }
    // Validate the absolute instant now, not after approval.
    createTimeResourceRef(required(params, "at"));
  } else {
    required(params, "resourceRef");
  }
  required(params, "instruction");
  return params;
}

function watchDomainDescription(): string {
  return (
      `Supported sources are 'train' and 'time'. For source='time', use event='time.reached' and pass exactly one of afterMinutes or at. Absolute at values must be RFC 3339 instants with an explicit UTC offset; they are normalized internally and user-facing times follow this Mac's ${Intl.DateTimeFormat().resolvedOptions().timeZone} timezone with the date-specific offset. ` +
      "Train events: train.platform_announced, train.platform_confirmed, train.platform_changed, train.departed, train.stop_arrived, train.stop_departed, train.delay_changed, train.eta_changed, train.cancelled, train.arrived. " +
      "If a scheduled-only platform is already present, watch train.platform_confirmed and train.platform_changed rather than platform_announced. " +
      "For stop events, where.positionRelativeToDestination=-1 means the stop immediately before the user's destination and 0 means the destination. A named stop must use train.stop_arrived/train.stop_departed with where.station or where.stationId; train.arrived always means the current trainRef destination. For another downstream station on the same physical run, create a separate watcher on the same trainRef with a named-stop rule. Use once=true for one-shot milestones."
      + " For a time-relative milestone use trigger={kind:'before_time',field:'estimatedArrivalMs',minutes:30}; it follows live ETA changes and fires on the first poll inside the window."
  );
}

function watchParameters(agentWatch: boolean): ToolDefinition["parameters"] {
  return {
      type: "object",
      properties: {
        source: { type: "string", enum: ["train", "time"], description: "Watch adapter name." },
        resourceRef: { type: "string", description: "For trains, the opaque trainRef from find_next_train. Omit for time watches." },
        at: { type: "string", description: "For time watches, RFC 3339 date-time with explicit UTC offset, e.g. 2026-09-21T09:00:00+02:00. Uses the same instant convention as Calendar." },
        afterMinutes: { type: "number", exclusiveMinimum: 0, maximum: 525600, description: "For a relative time watch, minutes from now. Mutually exclusive with at." },
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
          continuation: { type: "object", properties: {
            outcomes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Structured action outcomes that schedule the next attempt, e.g. not_answered, busy, or failed." },
            afterMinutes: { type: "number", exclusiveMinimum: 0, maximum: 1440 },
            maxAttempts: { type: "number", minimum: 2, maximum: 60, description: "Total attempts including the first one." },
          }, required: ["outcomes", "afterMinutes", "maxAttempts"], additionalProperties: false },
          ...(agentWatch ? { grants: { type: "array", items: { type: "object", properties: {
            tool: { type: "string", enum: watchCapabilityNames() },
            maxInvocations: { type: "number", minimum: 1, description: "Maximum uses per matching event. Omit for mcp__voice__call_start: one call is always allowed; retries belong only in continuation." },
            constraints: { type: "object", properties: {
              fields: { type: "object", additionalProperties: { type: "object", properties: {
                kind: { type: "string", enum: ["exact", "template", "relative_time", "one_of", "range"] },
                value: {},
                template: { type: "string" },
                reference: { type: "string", description: "Trusted state.* or event.* timestamp path." },
                offsetMinutes: { type: "number", description: "Minutes added to the referenced timestamp; negative means before." },
                values: { type: "array", items: {} },
                min: { type: "number" },
                max: { type: "number" },
              }, required: ["kind"], additionalProperties: false } },
              denyExtraFields: { type: "boolean", description: "Must be true for side-effecting capabilities." },
            }, required: ["fields", "denyExtraFields"], additionalProperties: false, description: "Required for write tools. Omit entirely for mcp__voice__call_start, which accepts no arguments." },
          }, required: ["tool"], additionalProperties: false } } } : {}),
        }, required: ["id"], additionalProperties: false } },
        instruction: { type: "string", description: "The user's notification preference, preserved for the future agent turn." },
        expiresAt: { type: "string", description: "Optional ISO 8601 expiry; the adapter otherwise chooses a safe default." },
      },
      required: ["source", "rules", "instruction"],
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
function timeResourceRef(params: Record<string, unknown>): string {
  const hasAfter = params.afterMinutes !== undefined;
  const hasAbsolute = params.at !== undefined;
  if (hasAfter === hasAbsolute) throw new Error("A time watch requires exactly one of afterMinutes or at");
  if (hasAfter) {
    const minutes = params.afterMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > 525_600) {
      throw new Error("afterMinutes must be greater than 0 and no more than 525600");
    }
    return createTimeResourceRef(new Date(Date.now() + minutes * 60_000).toISOString());
  }
  return createTimeResourceRef(required(params, "at"));
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
    const continuation = parseContinuation(row.continuation);
    if (continuation && !allowGrants) throw new Error("Continuations require create_agent_watch");
    if (continuation && !grants.length) throw new Error("A continuation requires a rule-scoped grant");
    return {
      id: required(row, "id"), ...(event ? { event } : {}), ...(trigger ? { trigger } : {}),
      ...(row.where && typeof row.where === "object" && !Array.isArray(row.where) ? { where: row.where as Record<string, unknown> } : {}),
      ...(row.once === true ? { once: true } : {}),
      ...(grants.length ? { grants } : {}),
      ...(continuation ? { continuation } : {}),
    };
  });
}

function parseContinuation(value: unknown): WatchRule["continuation"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuation must be an object");
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.outcomes) || !row.outcomes.length
    || !row.outcomes.every((entry) => typeof entry === "string" && entry.trim() && entry.length <= 80)) {
    throw new Error("continuation.outcomes must contain non-empty structured outcome names");
  }
  if (typeof row.afterMinutes !== "number" || !Number.isFinite(row.afterMinutes)
    || row.afterMinutes <= 0 || row.afterMinutes > 1440) throw new Error("continuation.afterMinutes must be between 0 and 1440");
  if (!Number.isInteger(row.maxAttempts) || (row.maxAttempts as number) < 2 || (row.maxAttempts as number) > 60) {
    throw new Error("continuation.maxAttempts must be an integer between 2 and 60");
  }
  return { outcomes: [...new Set(row.outcomes.map((entry) => String(entry).trim()))], afterMinutes: row.afterMinutes, maxAttempts: row.maxAttempts as number };
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
  return value.map(parseWatchGrant);
}
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} }; }
