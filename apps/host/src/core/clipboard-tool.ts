/**
 * Host-native clipboard tool. The actual clipboard write is intentionally done
 * by the channel client when the user clicks Approve on the gated tool card:
 * that gesture targets the local device clipboard (Mac app, browser, phone)
 * and satisfies browser user-activation rules.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function buildClipboardTool(): ToolDefinition {
  return {
    name: "copy_to_clipboard",
    label: "copy_to_clipboard",
    description:
      "Copy exact text to the user's local clipboard. This is a sensitive side effect: " +
      "the host will ask the user to approve, and the client copies the text when they approve. " +
      "Use this only when the user asks you to put text in their clipboard or when copying a concrete generated snippet would be useful.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact text to place on the clipboard." },
        label: { type: "string", description: "Optional short label shown in the approval card." },
      },
      required: ["text"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    prepareArguments: (a: unknown) => a as never,
    execute: async (_id: string, params: { text?: unknown; label?: unknown }) => {
      const text = typeof params?.text === "string" ? params.text : "";
      if (!text) {
        return {
          content: [{ type: "text", text: JSON.stringify({ copied: false, error: "copy_to_clipboard requires non-empty text" }) }],
          details: {},
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            copied: true,
            length: text.length,
            label: typeof params.label === "string" && params.label.trim() ? params.label.trim() : undefined,
          }),
        }],
        details: {},
      };
    },
  } as ToolDefinition;
}
