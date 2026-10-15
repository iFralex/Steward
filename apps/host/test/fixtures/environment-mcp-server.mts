import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'environment-fixture',version:'0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'environment',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async req=>({content:[{type:'text',text:JSON.stringify(
  Object.fromEntries(((req.params.arguments?.keys ?? []) as string[]).map(key=>[key,process.env[key]??null]))
)}]}));
await server.connect(new StdioServerTransport());
