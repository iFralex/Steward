/**
 * Phase 1 demo tool: a sensitive `send_email` tool used to validate the
 * gating + approval-rendering flow WITHOUT building the real Mail
 * connector yet. It is a stub — on approval it just logs the draft. The
 * real Mail MCP server (Phase 2) will expose the same shape.
 *
 * Built with the Agent SDK's in-process SDK-MCP helpers (reuse, not a
 * hand-rolled tool). Exposed to the agent as `mcp__demo__send_email`,
 * which the default-deny policy gates (so it always asks first).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function createDemoMcpServer() {
  return createSdkMcpServer({
    name: "demo",
    tools: [
      tool(
        "send_email",
        "Prepare and send an email. Phase 1 STUB: does not actually send — it drafts and logs. Requires user approval.",
        {
          to: z.string().describe("Recipient email address"),
          subject: z.string().describe("Email subject"),
          body: z.string().describe("Email body (plain text)"),
        },
        async (args) => {
          console.log("[demo.send_email] (stub) approved draft:", args);
          return {
            content: [
              { type: "text", text: `Drafted email to ${args.to} — "${args.subject}" (stub, not actually sent).` },
            ],
          };
        },
      ),
    ],
  });
}
