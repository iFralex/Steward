export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type OpenAIChatRequest = { model?: string; messages: ChatMessage[] };
export type RunQuery = (args: { prompt: string; systemPrompt?: string; model?: string }) => AsyncIterable<unknown>;

/** Split OpenAI messages into the Agent SDK's systemPrompt + a single prompt string. */
export function splitPrompt(messages: ChatMessage[]): { systemPrompt: string | undefined; prompt: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const prompt = rest.length === 1 ? rest[0].content : rest.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  return { systemPrompt: system.length ? system : undefined, prompt };
}

/** Concatenate the text of every text block of every assistant message in the stream. */
export async function collectAssistantText(messages: AsyncIterable<unknown>): Promise<string> {
  let out = "";
  for await (const m of messages) {
    const msg = m as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message!.content!) {
        if (block.type === "text" && typeof block.text === "string") out += block.text;
      }
    }
  }
  return out;
}

/** Run one OpenAI chat-completion request through the injected query and shape the response. */
export async function handleChatCompletion(
  body: OpenAIChatRequest,
  runQuery: RunQuery,
  now: () => number = Date.now,
): Promise<object> {
  const { systemPrompt, prompt } = splitPrompt(body.messages ?? []);
  const content = await collectAssistantText(runQuery({ prompt, systemPrompt, model: body.model }));
  const created = Math.floor(now() / 1000);
  return {
    id: `chatcmpl-sub-${now()}`,
    object: "chat.completion",
    created,
    model: body.model ?? "claude-sub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
