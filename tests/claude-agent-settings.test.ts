import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-agent-settings-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const contracts = await import("../src/core/contracts/claude-agent.ts");
const { subscriptionLabel, isSubscriptionModel } = await import("../src/core/prices.ts");
const { mapSupportedModels } = await import("../src/agent/claude-agent/models.ts");
const registry = await import("../src/agent/claude-agent/registry.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

describe("claude agent contracts", () => {
	it("round-trips provider ids and rejects malformed ones", () => {
		assert.equal(contracts.claudeAgentProviderId("work"), "claude-agent-work");
		assert.equal(contracts.claudeAgentInstanceId("claude-agent-my-work"), "my-work");
		assert.equal(contracts.claudeAgentInstanceId("claude-agent-"), undefined);
		assert.equal(contracts.claudeAgentInstanceId("claude-agent-Bad_Id"), undefined);
		assert.equal(contracts.isClaudeAgentProvider("anthropic"), false);
	});

	it("slugs names uniquely", () => {
		assert.equal(contracts.claudeAgentSlug("My Work Account"), "my-work-account");
		assert.equal(contracts.claudeAgentSlug("Work", ["work", "work-2"]), "work-3");
		assert.equal(contracts.claudeAgentSlug("!!!"), "instance");
	});

	it("sanitizes the settings section", () => {
		const out = contracts.sanitizeClaudeAgentSettings({
			instances: [
				{ id: "private", name: " Private ", configDir: " ~/.claude-private ", allowBackgroundUse: true },
				{ id: "private", name: "Duplicate", binaryPath: "" },
				{ name: "" },
				"junk",
			],
		});
		assert.deepEqual(out.instances, [
			{ id: "private", name: "Private", configDir: "~/.claude-private", allowBackgroundUse: true },
			{ id: "duplicate", name: "Duplicate", allowBackgroundUse: false },
		]);
		assert.deepEqual(contracts.sanitizeClaudeAgentSettings(undefined), { instances: [] });
	});

	it("labels usage as a subscription", () => {
		assert.equal(subscriptionLabel("claude-agent-my-work:claude-opus-4-8"), "Claude Agent · My Work");
		assert.equal(isSubscriptionModel("claude-agent-private:claude-haiku-4-5"), true);
		assert.equal(subscriptionLabel("anthropic:claude-opus-4-8"), undefined);
	});

	it("builds the sign-in command", () => {
		assert.equal(contracts.claudeAgentLoginCommand({ configDir: "~/.claude-private" }), "CLAUDE_CONFIG_DIR=~/.claude-private claude");
		assert.equal(contracts.claudeAgentLoginCommand({ binaryPath: "/opt/claude" }), "/opt/claude");
	});
});

describe("claude agent spawn options", () => {
	it("isolates the account: strips inherited Anthropic env, applies only the config dir's env block", async () => {
		const { baseOptions, gatewayHost } = await import("../src/agent/claude-agent/sdk.ts");
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-config-"));
		fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
			env: { ANTHROPIC_BASE_URL: "http://localhost:6655/anthropic", ANTHROPIC_AUTH_TOKEN: "fixture-token", NUMERIC: 3 },
			hooks: { PreToolUse: [] },
			model: "claude-sonnet-4-6",
		}));
		const saved = { ...process.env };
		process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "leaked";
		process.env.ANTHROPIC_API_KEY = "leaked";
		process.env.CLAUDE_CODE_USE_BEDROCK = "1";
		try {
			const options = baseOptions({ id: "work", name: "Work", configDir, binaryPath: process.execPath, allowBackgroundUse: false });
			const env = options.env as Record<string, string | undefined>;
			assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
			assert.equal(env.ANTHROPIC_API_KEY, undefined);
			assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
			assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:6655/anthropic");
			assert.equal(env.ANTHROPIC_AUTH_TOKEN, "fixture-token");
			assert.equal(env.NUMERIC, undefined);
			assert.equal(env.CLAUDE_CONFIG_DIR, configDir);
			assert.equal(env.PATH, process.env.PATH);
			assert.deepEqual(options.settingSources, []);
			assert.deepEqual(options.tools, []);
			assert.equal(gatewayHost(configDir), "localhost:6655");
			assert.equal(gatewayHost(path.join(configDir, "missing")), undefined);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("claude agent models", () => {
	it("maps Claude's list onto catalog ids, preferring explicit model values over aliases", () => {
		const catalog = new Set(["claude-opus-4-8", "claude-fable-5-1", "claude-haiku-4-5"]);
		const mapped = mapSupportedModels([
			{ value: "default", resolvedModel: "claude-opus-4-8" },
			{ value: "opus", resolvedModel: "claude-opus-4-8" },
			{ value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1" },
			{ value: "haiku", resolvedModel: "claude-haiku-4-5" },
			{ value: "mystery", resolvedModel: "claude-mystery-9" },
		], catalog);
		assert.deepEqual([...mapped.models], [["claude-opus-4-8", "opus"], ["claude-fable-5-1", "claude-fable-5-1[1m]"], ["claude-haiku-4-5", "haiku"]]);
		assert.deepEqual(mapped.unmatched, ["claude-mystery-9"]);
	});

	it("resolves engines from the anthropic catalog with zero cost", () => {
		registry.configureClaudeAgent(() => [{ id: "private", name: "Private", allowBackgroundUse: false }]);
		const engine = piEngineForSpec({ provider: "claude-agent-private", id: "claude-haiku-4-5" });
		assert.equal(engine.model.provider, "claude-agent-private");
		assert.equal(engine.model.cost.input, 0);
		assert.equal(engine.model.api, "anthropic-messages");
		assert.throws(() => piEngineForSpec({ provider: "claude-agent-unknown", id: "claude-haiku-4-5" }));
		assert.equal(registry.claudeAgentConnected("claude-agent-private"), true);
		assert.equal(registry.claudeAgentBackgroundAllowed("claude-agent-private"), false);
		assert.deepEqual(registry.claudeAgentModels(), [], "unchecked instances offer no picker models");
	});
});
