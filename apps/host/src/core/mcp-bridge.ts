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
    await client.connect(transport);
    clients.push(client);

    const { tools: mcpTools } = await client.listTools();
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
  }

  return {
    tools,
    close: async () => {
      for (const c of clients) await c.close();
    },
  };
}
