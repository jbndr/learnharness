import { getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessage, type Message, type SimpleStreamOptions, type StopReason, type StreamFunction, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { query, type EffortLevel, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { claudeAgentInstanceId, claudeAgentLabel, claudeAgentLoginCommand, type ClaudeAgentInstance } from "../../core/contracts/claude-agent.ts";
import { claudeAgentInstance, claudeAgentSdkModel } from "./registry.ts";
import { baseOptions, type QueryFn } from "./sdk.ts";
import { renderTranscript } from "./transcript.ts";

const SERVER = "lh";
const TOOL_PREFIX = `mcp__${SERVER}__`;

export function claudeAgentError(provider: string, message: string, instance?: ClaudeAgentInstance): string {
	const label = claudeAgentLabel(`${provider}:`) ?? "Claude Agent";
	if (/background/i.test(message)) return `${label} background use is off. Enable it in Providers to run this work.`;
	if (/binary not found|ENOENT/i.test(message)) return `${label}: the claude binary was not found. Set its path in Providers.`;
	if (/authentication|not signed in|not logged in|login|401|oauth|verification_required|account_on_hold/i.test(message)) {
		const command = instance ? claudeAgentLoginCommand(instance) : "claude";
		return `${label} is not signed in. Run \`${command}\`, use /login, then press Check in Providers.`;
	}
	if (/rate.?limit|usage limit|429|quota/i.test(message)) return `${label} usage limit reached. Try again later or switch instance.`;
	if (/overloaded|529/i.test(message)) return `${label}: Claude is overloaded. Try again shortly.`;
	if (/abort|cancel/i.test(message)) return `${label} request cancelled.`;
	if (/model_not_found|model/i.test(message)) return `${label}: the selected model is unavailable for this account. Press Check in Providers and choose another model.`;
	return `${label} request failed: ${message}`;
}

function effortFor(level: SimpleStreamOptions["reasoning"]): EffortLevel | undefined {
	if (!level) return undefined;
	return level === "minimal" ? "low" : (level as EffortLevel);
}

function toolServer(tools: readonly Tool[]): McpServer {
	const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
	const declared = tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as { type: "object" } }));
	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: declared }));
	server.server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [{ type: "text" as const, text: "Tool execution happens outside this session." }] }));
	return server;
}

function emptyMessage(model: { api: Api; provider: string; id: string }): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function stopReasonOf(raw: string | null | undefined): Extract<StopReason, "stop" | "length" | "toolUse"> {
	if (raw === "tool_use") return "toolUse";
	if (raw === "max_tokens" || raw === "model_context_window_exceeded") return "length";
	return "stop";
}

interface RawUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

/** Streams one model call through Claude Code; tool calls are returned to the caller, never executed. */
export function claudeAgentStream(background: () => boolean, run: QueryFn = query): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const partial = emptyMessage(model);
		const instance = claudeAgentInstance(model.provider);
		const fail = (reason: "error" | "aborted", raw: string) => {
			partial.stopReason = reason;
			partial.errorMessage = claudeAgentError(model.provider, raw, instance);
			output.push({ type: "error", reason, error: partial });
		};
		void (async () => {
			let started = false;
			let finished = false;
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			let q: ReturnType<QueryFn> | undefined;
			try {
				if (!instance) throw new Error("model unavailable: unknown Claude Agent instance");
				if (background() && !instance.allowBackgroundUse) throw new Error("background use disabled");
				if (options?.signal?.aborted) throw new Error("aborted");
				const messages = context.messages as Message[];
				const prompt: SDKUserMessage = {
					type: "user",
					message: { role: "user", content: renderTranscript(messages.filter((m) => m.role !== "system")) },
					parent_tool_use_id: null,
				};
				async function* once(): AsyncGenerator<SDKUserMessage> { yield prompt; }
				const effort = effortFor(options?.reasoning);
				const queryOptions: Options = {
					...baseOptions(instance),
					systemPrompt: getCurrentSystemPrompt(messages),
					model: claudeAgentSdkModel(claudeAgentInstanceId(model.provider)!, model.id),
					...(effort ? { effort, thinking: { type: "adaptive", display: "summarized" } } : { thinking: { type: "disabled" } }),
					includePartialMessages: true,
					maxTurns: 1,
					abortController: controller,
					mcpServers: { [SERVER]: { type: "sdk", name: SERVER, instance: toolServer(getCurrentTools(messages)) } },
					canUseTool: async () => ({ behavior: "deny", message: "Deferred to the caller.", interrupt: true }),
				};
				q = run({ prompt: once(), options: queryOptions });
				const blocks = new Map<number, { index: number; json?: string }>();
				let stopReason: string | null | undefined;
				const applyUsage = (u: RawUsage | undefined) => {
					if (!u) return;
					if (u.input_tokens != null) partial.usage.input = u.input_tokens;
					if (u.output_tokens != null) partial.usage.output = u.output_tokens;
					if (u.cache_read_input_tokens != null) partial.usage.cacheRead = u.cache_read_input_tokens;
					if (u.cache_creation_input_tokens != null) partial.usage.cacheWrite = u.cache_creation_input_tokens;
					partial.usage.totalTokens = partial.usage.input + partial.usage.output + partial.usage.cacheRead + partial.usage.cacheWrite;
				};
				const start = () => {
					if (started) return;
					started = true;
					output.push({ type: "start", partial });
				};
				for await (const message of q as AsyncIterable<SDKMessage>) {
					if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) throw new Error(message.error);
					if (message.type === "result" && message.is_error && !finished) throw new Error("errors" in message ? message.errors.join("; ") || message.subtype : message.subtype);
					if (message.type !== "stream_event" || message.parent_tool_use_id !== null) continue;
					const event = message.event;
					if (event.type === "message_start") {
						start();
						applyUsage(event.message.usage);
					} else if (event.type === "content_block_start") {
						start();
						const block = event.content_block;
						const index = partial.content.length;
						if (block.type === "text") {
							partial.content.push({ type: "text", text: "" });
							blocks.set(event.index, { index });
							output.push({ type: "text_start", contentIndex: index, partial });
						} else if (block.type === "thinking") {
							partial.content.push({ type: "thinking", thinking: "" });
							blocks.set(event.index, { index });
							output.push({ type: "thinking_start", contentIndex: index, partial });
						} else if (block.type === "redacted_thinking") {
							partial.content.push({ type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true });
							blocks.set(event.index, { index });
							output.push({ type: "thinking_start", contentIndex: index, partial });
						} else if (block.type === "tool_use") {
							const name = block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name;
							partial.content.push({ type: "toolCall", id: block.id, name, arguments: {} });
							blocks.set(event.index, { index, json: "" });
							output.push({ type: "toolcall_start", contentIndex: index, partial });
						}
					} else if (event.type === "content_block_delta") {
						const slot = blocks.get(event.index);
						if (!slot) continue;
						const part = partial.content[slot.index];
						if (!part) continue;
						const delta = event.delta;
						if (delta.type === "text_delta" && part.type === "text") {
							part.text += delta.text;
							output.push({ type: "text_delta", contentIndex: slot.index, delta: delta.text, partial });
						} else if (delta.type === "thinking_delta" && part.type === "thinking") {
							part.thinking += delta.thinking;
							output.push({ type: "thinking_delta", contentIndex: slot.index, delta: delta.thinking, partial });
						} else if (delta.type === "signature_delta" && part.type === "thinking") {
							part.thinkingSignature = (part.thinkingSignature ?? "") + delta.signature;
						} else if (delta.type === "input_json_delta" && part.type === "toolCall") {
							slot.json += delta.partial_json;
							output.push({ type: "toolcall_delta", contentIndex: slot.index, delta: delta.partial_json, partial });
						}
					} else if (event.type === "content_block_stop") {
						const slot = blocks.get(event.index);
						if (!slot) continue;
						const part = partial.content[slot.index];
						if (!part) continue;
						if (part.type === "text") output.push({ type: "text_end", contentIndex: slot.index, content: part.text, partial });
						else if (part.type === "thinking") output.push({ type: "thinking_end", contentIndex: slot.index, content: part.thinking, partial });
						else {
							const raw = slot.json || "{}";
							try {
								const parsed: unknown = JSON.parse(raw);
								if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
								part.arguments = parsed as ToolCall["arguments"];
							} catch {
								part.argumentsError = `Tool arguments were not a JSON object: ${raw}`;
							}
							output.push({ type: "toolcall_end", contentIndex: slot.index, toolCall: part, partial });
						}
					} else if (event.type === "message_delta") {
						stopReason = event.delta.stop_reason;
						applyUsage(event.usage as RawUsage);
					} else if (event.type === "message_stop") {
						finished = true;
						break;
					}
				}
				if (!finished) throw new Error(controller.signal.aborted ? "aborted" : "Claude ended without a response");
				partial.stopReason = stopReasonOf(stopReason);
				output.push({ type: "done", reason: partial.stopReason as "stop" | "length" | "toolUse", message: partial });
			} catch (error) {
				if (finished) return;
				const aborted = controller.signal.aborted || options?.signal?.aborted === true;
				fail(aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
				try { q?.close(); } catch { /* already closed */ }
				output.end();
			}
		})();
		return output;
	};
}
