/**
 * Manual live smoke test for the train assistant.
 *
 * It exercises the same ChatManager/tool path as the PWA, uses the real LLM
 * gateway and ViaggiaTreno MCP, then feeds deterministic train state changes
 * through the generic watch engine and LLM notification path.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "steward-train-smoke-"));
process.env.CHATS_DIR = join(dir, "chats");
process.env.WATCH_DB = join(dir, "watches.db");
process.env.AUDIT_DIR = join(dir, "audit");
process.env.USAGE_DIR = join(dir, "usage");
process.env.ACTION_CENTER_DIR = join(dir, "actions");

const [{ loadConfig }, { ChatManager }, { Session }, { chatStore }, watch, adapterModule, notificationModule] = await Promise.all([
  import("../src/config.ts"),
  import("../src/core/agent-runner.ts"),
  import("../src/core/session.ts"),
  import("../src/core/chat-store.ts"),
  import("@steward/watch-engine"),
  import("../src/core/train-watch-adapter.ts"),
  import("../src/core/watch-notification-service.ts"),
]);

const config = loadConfig();
config.mcpServers = { trains: config.mcpServers.trains };
const channelEvents: any[] = [];
const emit = (event: any) => {
  channelEvents.push(event);
  if (event.type === "tool_call") console.log(`TOOL CALL ${event.tool} ${JSON.stringify(event.input)}`);
  if (event.type === "tool_result") console.log(`TOOL RESULT ${event.tool} ok=${event.ok}`);
  if (event.type === "approval_request") console.log(`UNEXPECTED APPROVAL ${event.tool}`);
};
const session = new Session(emit, 2_000);
const runner = new ChatManager(config, session, emit);
const store = chatStore();
const chat = store.createChat("Smoke test treni");

async function turn(text: string): Promise<void> {
  const before = store.getMessages(chat.id).length;
  console.log(`\nUSER: ${text}`);
  await runner.runTurn(chat.id, text);
  for (const message of store.getMessages(chat.id).slice(before)) {
    if (message.role === "assistant") console.log(`ASSISTANT: ${message.text}`);
  }
}

await turn("La dettatura potrebbe essere sbagliata: qual è il prossimo treno diretto da Milano rogo redo a Bologna Centrale? Dimmi orario, ritardo e se il binario è confermato, solo programmato o non comunicato.");
await turn("Aggiorna adesso lo stato dello stesso treno usando il riferimento già ottenuto.");
await turn("Avvisami quando esce il binario, quando il treno parte, quando arriva alla fermata prima di Bologna Centrale e quando arriva a Bologna e devo scendere. Crea un unico monitor con eventi una sola volta.");
await turn("Ferma il monitoraggio del treno che hai appena creato.");

const approvals = channelEvents.filter((event) => event.type === "approval_request");
if (approvals.length) throw new Error(`The automatic train/watch flow requested ${approvals.length} approval(s).`);
for (const expected of ["mcp__trains__find_next_train", "mcp__trains__train_status", "create_watch", "stop_watch"]) {
  if (!channelEvents.some((event) => event.type === "tool_call" && event.tool === expected)) {
    throw new Error(`The chat did not call ${expected}.`);
  }
}

const baseline = trainSnapshot();
let current = baseline;
const fakeService = { status: async () => current };
const watchStore = watch.WatchStore.open(join(dir, "event-simulation.db"));
const engine = new watch.WatchEngine(watchStore).register(new adapterModule.TrainWatchAdapter(fakeService));
const simulated = await engine.create({
  source: "train", resourceRef: baseline.trainRef, chatId: chat.id,
  instruction: "Avvisami in italiano in modo breve e accessibile, dicendomi chiaramente quando devo prepararmi e quando devo scendere.",
  rules: [
    { id: "platform", event: "train.platform_announced", once: true },
    { id: "departed", event: "train.departed", once: true },
    { id: "prepare", event: "train.stop_arrived", where: { positionRelativeToDestination: -1 }, once: true },
    { id: "get-off", event: "train.stop_arrived", where: { positionRelativeToDestination: 0 }, once: true },
  ],
});
const pushes: any[] = [];
const push = { sendAll: async (payload: any) => { pushes.push(payload); console.log(`PUSH: ${payload.body}`); } };

async function transition(next: any): Promise<void> {
  current = next;
  await notificationModule.pollAndDeliverWatchEvents({ engine, runner, push: push as any });
}

await transition({ ...current, platform: "6", scheduledPlatform: "6", platformStatus: "scheduled", lastUpdated: new Date().toISOString() });
await transition({ ...current, departed: true, lastUpdated: new Date().toISOString() });
await transition({ ...current, stops: current.stops.map((stop: any) => stop.positionRelativeToDestination === -1 ? { ...stop, actualArrivalMs: Date.now(), actualArrival: "06:40" } : stop), lastUpdated: new Date().toISOString() });
await transition({ ...current, arrived: true, stops: current.stops.map((stop: any) => stop.positionRelativeToDestination === 0 ? { ...stop, actualArrivalMs: Date.now(), actualArrival: "07:00" } : stop), lastUpdated: new Date().toISOString() });

if (pushes.length !== 4) throw new Error(`Expected 4 simulated push notifications, got ${pushes.length}.`);
if (watchStore.get(simulated.id)?.status !== "completed") throw new Error("The simulated watch did not complete at destination.");
console.log(`\nSMOKE OK: 4 app-chat tools, 0 approvals, ${pushes.length} LLM-authored event notifications.`);
await runner.close();
watchStore.close();
process.exit(0);

function trainSnapshot(): any {
  return {
    trainRef: "vt1_smoke", trainNumber: "2451", category: "REG", from: "MILANO ROGOREDO", to: "BOLOGNA CENTRALE",
    scheduledDeparture: "18/09/26, 05:25", scheduledArrival: "18/09/26, 07:00",
    scheduledDepartureMs: Date.now() + 10 * 60_000, scheduledArrivalMs: Date.now() + 105 * 60_000,
    delayMinutes: 0, platformStatus: "unknown", cancelled: false, departed: false, arrived: false,
    stops: [
      { id: "S01820", name: "MILANO ROGOREDO", index: 0, cancelled: false, positionRelativeToDestination: -2 },
      { id: "S05040", name: "ANZOLA DELL'EMILIA", index: 1, cancelled: false, positionRelativeToDestination: -1 },
      { id: "S05043", name: "BOLOGNA CENTRALE", index: 2, cancelled: false, positionRelativeToDestination: 0 },
    ],
    lastUpdated: new Date().toISOString(), source: "ViaggiaTreno",
  };
}
