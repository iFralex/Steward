import assert from "node:assert/strict";
import { test } from "node:test";
import { planMailAction, type PlanningMessage } from "../src/planner.ts";

function msg(): PlanningMessage {
  return {
    messageId: "m1",
    threadId: 7,
    fromName: "Marco",
    fromAddr: "marco@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: "Call domani alle 15?",
    date: 1782400000,
    bodyText: "Ciao Alessio, sei libero domani alle 15 per una call? Link: https://meet.example/x",
    mailbox: "INBOX",
  };
}

test("planMailAction stores executable scheduling proposals", async () => {
  let calls = 0;
  const card = await planMailAction(msg(), async (system, prompt) => {
    calls++;
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "scheduling-request",
        priority: "high",
        summary: "Marco propone una call.",
        dueDateTime: "2026-06-27T15:00:00.000Z",
        scheduling: {
          requestedSlots: [{ start: "2026-06-27T15:00:00.000Z", end: "2026-06-27T15:30:00.000Z" }],
          meetingTitle: "Call con Marco",
          meetingLink: "https://meet.example/x",
          calendarName: "Work",
        },
        replyDrafts: {
          accept: "Ciao Marco, sì, ci sono.",
          decline: "Ciao Marco, purtroppo non riesco.",
          proposeAlternative: "Ciao Marco, potremmo fare alle 18?",
          askClarification: null,
        },
        reasoning: "Scheduling request.",
      });
    }
    return JSON.stringify({
      title: "Call con Marco",
      summary: "Marco chiede una call domani alle 15.",
      proposedActions: [{
        id: "accept-and-create",
        label: "Accetta e crea evento",
        summary: "Risponde sì e crea l'evento.",
        confidence: "high",
        steps: [
          { id: "reply", label: "Send reply", tool: "mcp__mail__reply", input: { messageId: "m1", body: "Ciao Marco, sì, ci sono.", replyAll: true }, writes: true },
          { id: "event", label: "Create event", tool: "mcp__calendar__create_event", input: { calendar: "primary", summary: "Call con Marco", start: "2026-06-27T15:00:00.000Z", end: "2026-06-27T15:30:00.000Z", url: "https://meet.example/x", alarms: [{ trigger: 3600 }] }, writes: true },
        ],
      }],
    });
  });

  assert.equal(calls, 2);
  assert.ok(card);
  assert.equal(card.kind, "scheduling-request");
  assert.equal(card.proposedActions[0].steps[1].tool, "mcp__calendar__create_event");
  assert.equal(card.proposedActions[0].steps[1].input.calendar, "Work");
  assert.deepEqual(card.proposedActions[0].steps[1].input.alarms, [60]);
  assert.equal(card.contextSnapshot.mail?.messageId, "m1");
});

test("planMailAction can enrich context through generic read-only tools", async () => {
  const calls: string[] = [];
  const card = await planMailAction(msg(), async (system, userPrompt) => {
    calls.push(system);
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "scheduling-request",
        priority: "high",
        summary: "Marco propone una call.",
        dueDateTime: "2026-06-27T15:00:00.000Z",
        scheduling: {
          requestedSlots: [{ start: "2026-06-27T15:00:00.000Z", end: "2026-06-27T15:30:00.000Z" }],
          meetingTitle: "Call con Marco",
          meetingLink: "https://meet.example/x",
          calendarName: "Work",
        },
        replyDrafts: {
          accept: "Ciao Marco, sì, ci sono.",
          decline: "Ciao Marco, purtroppo non riesco.",
          proposeAlternative: null,
          askClarification: null,
        },
        reasoning: "Scheduling request.",
      });
    }
    if (system.startsWith("You decide which read-only tools")) {
      if (userPrompt.includes("previousObservations") && userPrompt.includes("mcp__calendar__search_events")) {
        return JSON.stringify({ toolCalls: [] });
      }
      return JSON.stringify({
        toolCalls: [{
          tool: "mcp__calendar__search_events",
          input: { start: "2026-06-27T15:00:00.000Z", end: "2026-06-27T15:30:00.000Z" },
          reason: "Check availability before proposing the reply.",
        }],
      });
    }
    return JSON.stringify({
      title: "Call con Marco",
      summary: "Marco chiede una call; calendar check found no conflicts.",
      proposedActions: [{
        id: "accept",
        label: "Accetta",
        summary: "Reply yes.",
        confidence: "high",
        steps: [{ id: "reply", label: "Send reply", tool: "mcp__mail__reply", input: { messageId: "m1", body: "Ciao Marco, sì, ci sono." }, writes: true }],
      }],
    });
  }, {
    readTool: async (tool, input) => ({ tool, input, events: [] }),
  });

  assert.ok(card);
  assert.ok(calls.length >= 3);
  const toolContext = card.contextSnapshot.toolContext as { observations: { ok: boolean; tool: string }[] };
  assert.equal(toolContext.observations[0].ok, true);
  assert.equal(toolContext.observations[0].tool, "mcp__calendar__search_events");
  assert.equal(card.deadline.iso, "2026-06-27T15:00:00.000Z");
});

test("planMailAction can run follow-up read tools and removes read-only proposal steps", async () => {
  let toolRound = 0;
  const card = await planMailAction(msg(), async (system) => {
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "admin-task",
        priority: "high",
        summary: "Serve risposta validata.",
        dueDateTime: "2026-06-26T21:59:59.000Z",
        scheduling: null,
        replyDrafts: { accept: "Ciao, confermo.", decline: null, proposeAlternative: null, askClarification: null },
        reasoning: "Administrative task.",
      });
    }
    if (system.startsWith("You decide which read-only tools")) {
      toolRound++;
      return JSON.stringify({
        toolCalls: toolRound === 1
          ? [{ tool: "mcp__mail__get_thread", input: { threadId: 7 }, reason: "Read thread first." }]
          : [{ tool: "mcp__calendar__search_events", input: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" }, reason: "Validate dates discovered in thread." }],
      });
    }
    return JSON.stringify({
      title: "Rispondi con dati validati",
      summary: "Usa le osservazioni già raccolte.",
      proposedActions: [{
        id: "validated-reply",
        label: "Rispondi",
        summary: "Reply using validated facts.",
        confidence: "high",
        steps: [
          { id: "read", label: "Search calendar", tool: "mcp__calendar__search_events", input: { query: "x" }, writes: false },
          { id: "reply", label: "Send reply", tool: "mcp__mail__reply", input: { messageId: "m1", body: "Ciao, confermo." }, writes: true },
        ],
      }],
    });
  }, {
    readTool: async (tool) => tool === "mcp__mail__get_thread"
      ? { messages: [{ snippet: "serve controllare calendario" }] }
      : { events: [] },
  });

  assert.ok(card);
  const toolContext = card.contextSnapshot.toolContext as { observations: { tool: string }[] };
  assert.deepEqual(toolContext.observations.map((o) => o.tool), [
    "mcp__mail__get_thread",
    "mcp__calendar__search_events",
  ]);
  assert.deepEqual(card.proposedActions[0].steps.map((s) => s.tool), ["mcp__mail__reply"]);
});
