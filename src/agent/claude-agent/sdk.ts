import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type ModelInfo, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentInstance } from "../../core/contracts/claude-agent.ts";
import { PATHS } from "../../../config.ts";

const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDECODE"];

export type QueryFn = typeof query;

function expandHome(p: string): string {
	return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function resolveClaudeBinary(instance: Pick<ClaudeAgentInstance, "binaryPath">): string {
	if (instance.binaryPath) {
		const explicit = expandHome(instance.binaryPath);
		if (!fs.existsSync(explicit)) throw new Error(`Claude binary not found at ${explicit}`);
		return explicit;
	}
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local")];
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = path.join(dir, "claude");
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error("Claude binary not found on PATH; set a binary path for this instance");
}

function workDir(): string {
	const dir = path.join(PATHS.data, "claude-agent-cwd");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** The `env` block of <configDir>/settings.json, e.g. a gateway URL and token. Nothing else from that file is used. */
export function configDirEnv(configDir: string | undefined): Record<string, string> {
	const file = path.join(expandHome(configDir ?? "~/.claude"), "settings.json");
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		const env = parsed && typeof parsed === "object" ? (parsed as { env?: unknown }).env : undefined;
		if (!env || typeof env !== "object" || Array.isArray(env)) return {};
		return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}

function inherited(key: string): boolean {
	return !STRIPPED_ENV.includes(key) && !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_CODE_USE_");
}

/** Spawn options shared by every run: the account's config dir and its env block, no other user settings, no built-in tools. */
export function baseOptions(instance: ClaudeAgentInstance): Options {
	const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited(key)));
	Object.assign(env, configDirEnv(instance.configDir));
	if (instance.configDir) env.CLAUDE_CONFIG_DIR = expandHome(instance.configDir);
	return {
		pathToClaudeCodeExecutable: resolveClaudeBinary(instance),
		env,
		cwd: workDir(),
		settingSources: [],
		tools: [],
		persistSession: false,
	};
}

export interface ClaudeAgentInspection {
	email?: string;
	subscription?: string;
	/** Host of the API gateway set in the config dir's env block, when it also provides a token. */
	gateway?: string;
	models: ModelInfo[];
}

export function gatewayHost(configDir: string | undefined): string | undefined {
	const env = configDirEnv(configDir);
	if (!env.ANTHROPIC_BASE_URL || !(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) return undefined;
	try {
		return new URL(env.ANTHROPIC_BASE_URL).host;
	} catch {
		return undefined;
	}
}

/** Reads the signed-in account and its model list without sending a prompt. */
export async function inspectClaudeAgent(instance: ClaudeAgentInstance, run: QueryFn = query): Promise<ClaudeAgentInspection> {
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	async function* idle(): AsyncGenerator<never> { await hold; }
	const q = run({ prompt: idle(), options: baseOptions(instance) });
	try {
		const account = await q.accountInfo();
		const models = await q.supportedModels();
		return { email: account.email, subscription: account.subscriptionType, gateway: gatewayHost(instance.configDir), models };
	} finally {
		release();
		q.close();
	}
}
