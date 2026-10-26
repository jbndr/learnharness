import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { renderTranscript } from "../src/agent/claude-agent/transcript.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("claude agent transcript", () => {
	it("renders turns, tool calls and results in order, skipping thinking", () => {
		const messages: Message[] = [
			{ role: "user", content: "Teach me photosynthesis", timestamp: 1 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "claude-agent-private",
				model: "claude-opus-4-8",
				content: [
					{ type: "thinking", thinking: "plan the lesson" },
					{ type: "text", text: "Let's start." },
					{ type: "toolCall", id: "toolu_1", name: "quiz", arguments: { question: "What does \"chlorophyll\" do?" } },
				],
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "toolu_1", toolName: "quiz", content: [{ type: "text", text: "Absorbs light" }], isError: false, timestamp: 3 },
		];
		const blocks = renderTranscript(messages);
		assert.equal(blocks.length, 1);
		const text = blocks[0]!.type === "text" ? blocks[0]!.text : "";
		assert.ok(text.startsWith("<conversation>\n<user>\nTeach me photosynthesis\n</user>\n"));
		assert.ok(!text.includes("plan the lesson"));
		const order = ["Let's start.", '<tool_call id="toolu_1" name="quiz">', '"What does \\"chlorophyll\\" do?"', '<tool_result id="toolu_1" name="quiz">', "Absorbs light", "</conversation>"];
		let at = 0;
		for (const piece of order) {
			const next = text.indexOf(piece, at);
			assert.ok(next >= at, `missing or out of order: ${piece}`);
			at = next;
		}
	});

	it("keeps images as image blocks and marks errored results", () => {
		const blocks = renderTranscript([
			{ role: "user", content: [{ type: "text", text: "Look:" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is it?" }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "nope" }], isError: true, timestamp: 2 },
		]);
		assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text"]);
		assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
		const tail = blocks[2]!.type === "text" ? blocks[2]!.text : "";
		assert.ok(tail.includes('<tool_result id="t" name="read" error="true">'));
	});
});
