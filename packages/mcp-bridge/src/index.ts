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
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function buildMcpBridge(specs: Record<string, McpServerSpec>): Promise<McpBridge> {
  const clients: Client[] = [];
  const clientsByServer = new Map<string, Client>();
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
      clientsByServer.set(server, client);
      for (const t of mcpTools) {
        const bareName = t.name;
        const fullName = `mcp__${server}__${bareName}`;
        tools.push({
          name: fullName,
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
    callTool: async (toolName, args) => {
      const parsed = parseBridgeToolName(toolName);
      if (!parsed) throw new Error(`Invalid MCP tool name: ${toolName}`);
      const client = clientsByServer.get(parsed.server);
      if (!client) throw new Error(`MCP server not available: ${parsed.server}`);
      const res: any = await client.callTool({ name: parsed.tool, arguments: args ?? {} });
      return res.content ?? [{ type: "text", text: "" }];
    },
    close: async () => {
      for (const c of clients) await c.close();
    },
  };
}

function parseBridgeToolName(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}
