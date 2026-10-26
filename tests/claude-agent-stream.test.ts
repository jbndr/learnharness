import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import { normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-agent-stream-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { configureClaudeAgent, claudeAgentModel } = await import("../src/agent/claude-agent/registry.ts");
const { claudeAgentStream } = await import("../src/agent/claude-agent/stream.ts");
type QueryFn = import("../src/agent/claude-agent/sdk.ts").QueryFn;

configureClaudeAgent(() => [
	{ id: "private", name: "Private", configDir: "/tmp/claude-private", binaryPath: process.execPath, allowBackgroundUse: false },
]);
const model = claudeAgentModel("claude-agent-private", "claude-haiku-4-5")!;

const se = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" });
const TOOL_TURN = [
	se({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Quiz time." } }),
	se({ type: "content_block_stop", index: 1 }),
	se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__lh__quiz", input: {} } }),
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"question":' } }),
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Why green?"}' } }),
	se({ type: "content_block_stop", index: 2 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
	se({ type: "message_stop" }),
	{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"] },
];

function fakeRun(script: unknown[], seen: { options?: Record<string, unknown>; closed: number }): QueryFn {
	return ((params: { options?: Record<string, unknown> }) => {
		seen.options = params.options;
		return {
			async *[Symbol.asyncIterator]() { for (const message of script) yield message; },
			close() { seen.closed++; },
		};
	}) as unknown as QueryFn;
}

function context() {
	return normalizeContext({
		systemPrompt: "You are a tutor.",
		tools: [{ name: "quiz", description: "Quiz the learner.", parameters: Type.Object({ question: Type.String() }) }],
		messages: [{ role: "user", content: "Teach me", timestamp: 1 }],
	});
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("claude agent stream", () => {
	it("translates a tool-use turn into pi events and stops before execution", async () => {
		const prior = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
		const seen = { closed: 0 } as { options?: Record<string, unknown>; closed: number };
		const events = await collect(claudeAgentStream(() => false, fakeRun(TOOL_TURN, seen))(model, context(), { reasoning: "high" }));
		if (prior === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prior;

		assert.deepEqual(events.map((e) => e.type), [
			"start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end",
			"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
		]);
		const done = events.at(-1);
		assert.ok(done?.type === "done");
		assert.equal(done.reason, "toolUse");
		assert.deepEqual(done.message.content, [
			{ type: "thinking", thinking: "Plan.", thinkingSignature: "sig" },
			{ type: "text", text: "Quiz time." },
			{ type: "toolCall", id: "toolu_1", name: "quiz", arguments: { question: "Why green?" } },
		]);
		assert.equal(done.message.provider, "claude-agent-private");
		assert.equal(done.message.usage.input, 100);
		assert.equal(done.message.usage.output, 42);
		assert.equal(done.message.usage.cost.total, 0);
		assert.equal(seen.closed, 1);

		const options = seen.options!;
		assert.equal(options.systemPrompt, "You are a tutor.");
		assert.deepEqual(options.tools, []);
		assert.deepEqual(options.settingSources, []);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.effort, "high");
		assert.equal(options.model, "claude-haiku-4-5");
		const env = options.env as Record<string, string | undefined>;
		assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-private");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		const decision = await (options.canUseTool as (...args: unknown[]) => Promise<{ behavior: string; interrupt?: boolean }>)("mcp__lh__quiz", {}, {});
		assert.equal(decision.behavior, "deny");
		assert.equal(decision.interrupt, true);
	});

	it("disables thinking when reasoning is off", async () => {
		const seen = { closed: 0 } as { options?: Record<string, unknown>; closed: number };
		await collect(claudeAgentStream(() => false, fakeRun(TOOL_TURN, seen))(model, context(), {}));
		assert.deepEqual(seen.options?.thinking, { type: "disabled" });
		assert.equal(seen.options?.effort, undefined);
	});

	it("maps an authentication failure to a sign-in hint", async () => {
		const seen = { closed: 0 } as { options?: Record<string, unknown>; closed: number };
		const script = [{ type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { content: [] } }];
		const events = await collect(claudeAgentStream(() => false, fakeRun(script, seen))(model, context(), {}));
		const last = events.at(-1);
		assert.ok(last?.type === "error");
		assert.equal(last.reason, "error");
		assert.match(last.error.errorMessage ?? "", /not signed in.*CLAUDE_CONFIG_DIR=\/tmp\/claude-private/);
	});

	it("refuses background work when the instance disallows it, without spawning", async () => {
		const seen = { closed: 0 } as { options?: Record<string, unknown>; closed: number };
		const events = await collect(claudeAgentStream(() => true, fakeRun(TOOL_TURN, seen))(model, context(), {}));
		assert.equal(seen.options, undefined);
		const last = events.at(-1);
		assert.ok(last?.type === "error");
		assert.match(last.error.errorMessage ?? "", /background use is off/);
	});

	it("reports an abort before any output", async () => {
		const controller = new AbortController();
		controller.abort();
		const seen = { closed: 0 } as { options?: Record<string, unknown>; closed: number };
		const events = await collect(claudeAgentStream(() => false, fakeRun(TOOL_TURN, seen))(model, context(), { signal: controller.signal }));
		const last = events.at(-1);
		assert.ok(last?.type === "error");
		assert.equal(last.reason, "aborted");
	});
});
