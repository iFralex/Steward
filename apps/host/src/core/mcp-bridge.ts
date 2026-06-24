/**
 * Bridges existing MCP servers (stdio) into Pi custom tools. Tool names are
 * mcp__<server>__<tool> so the existing tool-policy keys match verbatim; the
 * MCP server is called with the bare tool name.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface McpServerSpec {
  command: string;
  args: string[];
}

export interface McpBridge {
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export async function buildMcpBridge(specs: Record<string, McpServerSpec>): Promise<McpBridge> {
  const clients: Client[] = [];
  const tools: ToolDefinition[] = [];

  for (const [server, spec] of Object.entries(specs)) {
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args });
    const client = new Client({ name: `host-${server}`, version: "0.0.0" });
    // A connector that dies must not take down the whole host: swallow async
    // transport errors and skip a server that fails to start, keeping the rest.
    client.onerror = (err) => console.warn(`[mcp-bridge] ${server}: ${err?.message ?? err}`);
    try {
      await client.connect(transport);
      const { tools: mcpTools } = await client.listTools();
      clients.push(client);
      for (const t of mcpTools) {
        const bareName = t.name;
        tools.push({
          name: `mcp__${server}__${bareName}`,
          label: bareName,
          description: t.description ?? bareName,
          parameters: (t.inputSchema ?? { type: "object", properties: {} }) as any,
          prepareArguments: (a: unknown) => a as any,
          execute: async (_id: string, params: any) => {
            const res: any = await client.callTool({ name: bareName, arguments: params ?? {} });
            return { content: res.content ?? [{ type: "text", text: "" }], details: {} };
          },
        } as ToolDefinition);
      }
    } catch (err) {
      console.warn(
        `[mcp-bridge] skipping server "${server}" (${err instanceof Error ? err.message : String(err)})`,
      );
      try {
        await client.close();
      } catch {
        /* already gone */
      }
    }
  }

  return {
    tools,
    close: async () => {
      for (const c of clients) await c.close();
    },
  };
}
