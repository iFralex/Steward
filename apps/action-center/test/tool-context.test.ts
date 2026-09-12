import assert from "node:assert/strict";
import test from "node:test";
import { collectReadToolContext } from "../src/tool-context.ts";

test("normalizes LLM Wiki search aliases and caps Action results at five", async () => {
  let executedInput: Record<string, unknown> | undefined;
  const context = await collectReadToolContext({
    chat: async () => JSON.stringify({
      toolCalls: [{
        tool: "mcp__llm-wiki__llm_wiki_search",
        input: { query: "accessibility preferences", topK: 10, includeContent: false, ignored: "value" },
        reason: "Check relevant user context.",
      }],
    }),
    execute: async (_tool, input) => {
      executedInput = input;
      return { results: [] };
    },
    message: { subject: "Question" },
    analyzed: { kind: "informational" },
    maxCalls: 1,
  });

  assert.deepEqual(executedInput, {
    query: "accessibility preferences",
    top_k: 5,
    include_content: false,
  });
  assert.deepEqual(context.requested[0]?.input, executedInput);
});
