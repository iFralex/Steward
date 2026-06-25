/**
 * Host-native `ask_user` tool. Unlike the bridged MCP tools, it has no external
 * server: it asks the connected channel (UI) a multiple-choice question via the
 * session and returns the user's selection. Not gate-wrapped — asking a question
 * is not a sensitive action.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type AskQuestion = (q: { question: string; options: string[]; multiSelect: boolean }) => Promise<string[]>;

export function buildAskUserTool(askQuestion: AskQuestion): ToolDefinition {
  return {
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user a question with predefined options and get their selection back. " +
      "The channel shows the options as a single- or multi-select picker. Use this when a decision is " +
      "genuinely the user's to make, instead of guessing or asking in free-form text. " +
      "Returns {selected: string[]} — the chosen option labels (empty if the user made no choice).",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user" },
        options: { type: "array", items: { type: "string" }, description: "The selectable options (provide at least 2)" },
        multiSelect: { type: "boolean", description: "Allow selecting more than one option (default false)" },
      },
      required: ["question", "options"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    prepareArguments: (a: unknown) => a as never,
    execute: async (_id: string, params: { question?: unknown; options?: unknown; multiSelect?: unknown }) => {
      const question = typeof params?.question === "string" ? params.question : "";
      const options = Array.isArray(params?.options)
        ? (params.options.filter((o: unknown): o is string => typeof o === "string"))
        : [];
      const multiSelect = params?.multiSelect === true;
      if (!question.trim() || options.length < 2) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "ask_user requires a question and at least 2 options" }) }], details: {} };
      }
      const selected = await askQuestion({ question, options, multiSelect });
      return { content: [{ type: "text", text: JSON.stringify({ selected }) }], details: {} };
    },
  } as ToolDefinition;
}
