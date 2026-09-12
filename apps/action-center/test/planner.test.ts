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
  const eventStep = card.proposedActions[0].steps[1] as { tool: string; input: Record<string, unknown> };
  assert.equal(eventStep.tool, "mcp__calendar__create_event");
  assert.equal(eventStep.input.calendar, "Work");
  assert.deepEqual(eventStep.input.alarms, [60]);
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
  assert.deepEqual(card.proposedActions[0].steps.map((s) => (s as { tool?: string }).tool), ["mcp__mail__reply"]);
});

test("planMailAction keeps a manual step whose link appears in the mail body", async () => {
  const m = msg();
  m.bodyText = "Carica il certificato qui: https://portal.universita.example/upload prima di venerdì.";
  let calls = 0;
  const card = await planMailAction(m, async (system) => {
    calls++;
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "document-action",
        priority: "high",
        summary: "Carica il certificato sul portale.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
        reasoning: "Document upload requested.",
      });
    }
    return JSON.stringify({
      title: "Carica certificato",
      summary: "Il portale richiede il caricamento del certificato.",
      proposedActions: [{
        id: "upload",
        label: "Carica il certificato",
        summary: "Apri il portale e carica il documento.",
        confidence: "high",
        steps: [
          { id: "open-portal", label: "Apri il portale di caricamento", kind: "manual", links: [{ url: "https://portal.universita.example/upload", label: "Apri portale" }] },
        ],
      }],
    });
  });

  assert.equal(calls, 2);
  assert.ok(card);
  const step = card!.proposedActions[0].steps[0];
  assert.equal(step.kind, "manual");
  assert.deepEqual((step as { links?: { url: string }[] }).links, [{ url: "https://portal.universita.example/upload", label: "Apri portale" }]);
});

test("planMailAction drops a manual link that is not present in the mail body, but keeps the step", async () => {
  const m = msg();
  m.bodyText = "Ciao Alessio, ricordati di completare la procedura sul portale universitario.";
  const card = await planMailAction(m, async (system) => {
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "document-action",
        priority: "normal",
        summary: "Completa la procedura sul portale.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
        reasoning: "Portal action requested.",
      });
    }
    return JSON.stringify({
      title: "Completa la procedura",
      summary: "Il portale universitario richiede un'azione.",
      proposedActions: [{
        id: "portal",
        label: "Completa la procedura",
        summary: "Vai sul portale.",
        confidence: "medium",
        steps: [
          { id: "open-portal", label: "Apri il portale universitario", kind: "manual", links: [{ url: "https://not-in-the-email.example/made-up", label: "Portale" }] },
        ],
      }],
    });
  });

  assert.ok(card);
  const step = card!.proposedActions[0].steps[0];
  assert.equal(step.kind, "manual");
  assert.deepEqual((step as { links?: unknown[] }).links, []);
});

test("planMailAction safely upgrades a literal www link from the email to https", async () => {
  const m = msg();
  m.bodyText = "Accedi a www.example.com/account per scaricare il documento.";
  const card = await planMailAction(m, async (system) => {
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "document-action",
        priority: "normal",
        summary: "Scarica il documento.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: null },
        reasoning: "Document available.",
      });
    }
    return JSON.stringify({
      title: "Scarica documento",
      summary: "Documento disponibile.",
      relatedActionId: null,
      proposedActions: [{
        id: "download",
        label: "Scarica",
        summary: "Apri il portale.",
        confidence: "high",
        steps: [{ id: "open", label: "Apri il portale", kind: "manual", links: [{ url: "www.example.com/account" }] }],
      }],
    });
  });
  assert.ok(card);
  const step = card.proposedActions[0].steps[0] as { links?: { url: string }[] };
  assert.equal(step.links?.[0]?.url, "https://www.example.com/account");
});

test("planMailAction preserves a proposal mixing a tool step and a manual step", async () => {
  const m = msg();
  m.bodyText = "Ciao Alessio, conferma la presenza e carica il modulo qui: https://portal.example/modulo";
  const card = await planMailAction(m, async (system) => {
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "document-action",
        priority: "normal",
        summary: "Conferma e carica il modulo.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: "Confermo la presenza.", decline: null, proposeAlternative: null, askClarification: null },
        reasoning: "Reply plus document upload.",
      });
    }
    return JSON.stringify({
      title: "Conferma e carica il modulo",
      summary: "Serve una risposta e il caricamento del modulo.",
      proposedActions: [{
        id: "confirm-and-upload",
        label: "Conferma e carica",
        summary: "Rispondi e carica il modulo.",
        confidence: "high",
        steps: [
          { id: "reply", label: "Conferma la presenza", tool: "mcp__mail__reply", input: { messageId: m.messageId, body: "Confermo la presenza.", replyAll: false }, writes: true },
          { id: "upload", label: "Carica il modulo", kind: "manual", links: [{ url: "https://portal.example/modulo" }] },
        ],
      }],
    });
  });

  assert.ok(card);
  const steps = card!.proposedActions[0].steps;
  assert.equal(steps.length, 2);
  assert.equal((steps[0] as { tool?: string }).tool, "mcp__mail__reply");
  assert.equal(steps[1].kind, "manual");
});

test("planMailAction seeds cross-thread sent-mail search for administrative replies and surfaces a generic already-replied-elsewhere fact", async () => {
  const adminMsg: PlanningMessage = {
    ...msg(),
    threadId: 42,
    fromName: "Jane Ops",
    fromAddr: "jane.ops@example.com",
    subject: "Monthly status update needed",
    bodyText: "Please confirm your attendance status for last month and let us know if there is anything to report.",
  };
  const executed: { tool: string; input: Record<string, unknown> }[] = [];
  let planPayload: {
    contextSnapshot?: {
      mail?: { replyRequirements?: string[]; relatedMailFacts?: { kind?: string; meaning?: string }[] };
    };
  } = {};
  const card = await planMailAction(adminMsg, async (system, prompt) => {
    if (system.includes("Analyze")) {
      return JSON.stringify({
        needsAction: true,
        kind: "admin-task",
        priority: "normal",
        summary: "Provide monthly attendance status update.",
        dueDateTime: null,
        scheduling: null,
        replyDrafts: { accept: null, decline: null, proposeAlternative: null, askClarification: "Hi Jane, following up on the status update." },
        reasoning: "Administrative attendance status request.",
      });
    }
    if (system.startsWith("You decide which read-only tools")) {
      return JSON.stringify({ toolCalls: [] });
    }
    planPayload = JSON.parse(prompt) as typeof planPayload;
    return JSON.stringify({
      title: "Reply to Jane with status update",
      summary: "Use already-gathered observations.",
      proposedActions: [{
        id: "reply",
        label: "Reply",
        summary: "Send status update.",
        confidence: "medium",
        steps: [{ id: "send", label: "Send", tool: "mcp__mail__reply", input: { messageId: adminMsg.messageId, body: "Hi Jane, following up on the status update." }, writes: true }],
      }],
    });
  }, {
    // Generic, non-hardcoded address: proves the related-fact match is driven by opts.userAddrs, not a baked-in identity.
    userAddrs: ["me@example.com"],
    readTool: async (tool, input) => {
      executed.push({ tool, input });
      return tool === "mcp__mail__search_messages"
        ? [{
            subject: "Re: Weekly report",
            from: "Me <me@example.com>",
            date: "2026-06-26T09:55:29.000Z",
            mailUrl: "message://%3Cweekly-report@example.com%3E",
            snippet: "Nothing to report this week.",
          }]
        : [{ subject: "Monthly status update needed" }];
    },
  });

  assert.ok(card);
  assert.deepEqual(executed.map((c) => c.tool), [
    "mcp__mail__get_thread",
    "mcp__mail__search_messages",
  ]);
  assert.equal(executed[1].input.recipient, "jane.ops@example.com");
  assert.equal(executed[1].input.mailbox, undefined);
  assert.equal(executed[1].input.anyMailbox, true);
  assert.equal(executed[1].input.perMessage, true);

  // Requirement extraction now belongs to the LLM/prompt, not to case-specific regexes.
  assert.deepEqual(planPayload.contextSnapshot?.mail?.replyRequirements, []);

  // The fact fires because "me@example.com" is in userAddrs (userSet), not because of any hardcoded address.
  const fact = planPayload.contextSnapshot?.mail?.relatedMailFacts?.[0];
  assert.equal(fact?.kind, "already-replied-elsewhere");
  assert.equal(fact?.meaning, "The user already answered this request in another recent thread.");
});
