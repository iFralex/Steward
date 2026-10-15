import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildMcpBridge,connectorEnvironment} from '@steward/mcp-bridge';

test('connector allowlists preserve disabled/empty settings and isolate credentials',()=>{
  const source={STEWARD_CALENDAR_BRIDGE_DIR:'/fixture/bridge',MAIL_EMBED_ENDPOINT:'off',DOCUMENT_EMBED_ENDPOINT:'',
    GATEWAY_API_KEY:'fixture-gateway',LLM_WIKI_API_TOKEN:'fixture-wiki',STEWARD_AUTH_TOKEN:'fixture-host',DEEPSEEK_API_KEY:'fixture-provider',
    CALENDAR_INDEX_DB:'/fixture/calendar',STEWARD_RINGBACK_ENV:'/fixture/voice.env',NODE_PATH:'/fixture/modules'};
  const calendar=connectorEnvironment('calendar',source);
  assert.equal(calendar.STEWARD_CALENDAR_BRIDGE_DIR,source.STEWARD_CALENDAR_BRIDGE_DIR);
  assert.equal(calendar.CALENDAR_INDEX_DB,source.CALENDAR_INDEX_DB);
  assert.equal(calendar.MAIL_EMBED_ENDPOINT,'off');
  assert.equal(connectorEnvironment('documents',source).DOCUMENT_EMBED_ENDPOINT,'');
  assert.equal(connectorEnvironment('voice',source).STEWARD_RINGBACK_ENV,source.STEWARD_RINGBACK_ENV);
  assert.deepEqual(connectorEnvironment('unknown',source),{NODE_PATH:'/fixture/modules'});
  for(const id of ['calendar','mail','contacts','documents','llm-wiki','voice','shell']) {
    const env=connectorEnvironment(id,source);
    assert.equal(env.STEWARD_AUTH_TOKEN,undefined);assert.equal(env.DEEPSEEK_API_KEY,undefined);
    if(id!=='llm-wiki')assert.equal(env.LLM_WIKI_API_TOKEN,undefined);
    if(['voice','shell','llm-wiki'].includes(id))assert.equal(env.GATEWAY_API_KEY,undefined);
  }
});

test('real MCP children receive selected host configuration and explicit overrides only',async()=>{
  const values={STEWARD_CALENDAR_BRIDGE_DIR:'/synthetic/bridge',CALENDAR_INDEX_DB:'/synthetic/index',MAIL_EMBED_ENDPOINT:'off',
    STEWARD_AUTH_TOKEN:'synthetic-secret',DEEPSEEK_API_KEY:'synthetic-provider'};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  const fixture=fileURLToPath(new URL('./fixtures/environment-mcp-server.mts',import.meta.url));
  const bridge=await buildMcpBridge({calendar:{command:process.execPath,args:['--import','tsx',fixture],env:{CALENDAR_INDEX_DB:'/override/index'}},
    shell:{command:process.execPath,args:['--import','tsx',fixture]}});
  try {
    const read=async(server:string)=>JSON.parse((await bridge.callTool(`mcp__${server}__environment`,{keys:Object.keys(values)}) as {text:string}[])[0].text);
    assert.deepEqual(await read('calendar'),{...values,CALENDAR_INDEX_DB:'/override/index',STEWARD_AUTH_TOKEN:null,DEEPSEEK_API_KEY:null});
    assert.deepEqual(await read('shell'),Object.fromEntries(Object.keys(values).map(key=>[key,null])));
  } finally {await bridge.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
