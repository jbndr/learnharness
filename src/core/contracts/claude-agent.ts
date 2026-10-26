/** Claude Agent instances: named Claude subscriptions run through the Claude Agent SDK. */

export const CLAUDE_AGENT_PREFIX = "claude-agent-";
export const CLAUDE_AGENT_LABEL = "Claude Agent";

export interface ClaudeAgentInstance {
	id: string;
	name: string;
	/** CLAUDE_CONFIG_DIR for this account; absent = Claude's default (~/.claude). */
	configDir?: string;
	/** Absent = `claude` resolved from PATH. */
	binaryPath?: string;
	allowBackgroundUse: boolean;
}

export interface ClaudeAgentSettings {
	instances: ClaudeAgentInstance[];
}

export interface ClaudeAgentStatus {
	id: string;
	ok: boolean;
	checkedAt: string;
	email?: string;
	subscription?: string;
	/** API gateway host from the config dir's env block, when it authenticates that way. */
	gateway?: string;
	/** Catalog model ids this account can use. */
	models: string[];
	/** Ids Claude reported that have no catalog entry, so they cannot be offered. */
	unmatched: string[];
	error?: string;
}

export interface ClaudeAgentView {
	instances: ClaudeAgentInstance[];
	statuses: ClaudeAgentStatus[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function claudeAgentProviderId(instanceId: string): string {
	return `${CLAUDE_AGENT_PREFIX}${instanceId}`;
}

export function claudeAgentInstanceId(provider: string | undefined): string | undefined {
	if (!provider?.startsWith(CLAUDE_AGENT_PREFIX)) return undefined;
	const id = provider.slice(CLAUDE_AGENT_PREFIX.length);
	return SLUG.test(id) ? id : undefined;
}

export function isClaudeAgentProvider(provider: string | undefined): boolean {
	return claudeAgentInstanceId(provider) !== undefined;
}

export function claudeAgentSlug(name: string, taken: readonly string[] = []): string {
	const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "instance";
	let slug = base;
	for (let n = 2; taken.includes(slug); n++) slug = `${base}-${n}`;
	return slug;
}

/** "claude-agent-work:claude-opus-4-8" → "Claude Agent · Work". Names come from the slug, not settings. */
export function claudeAgentLabel(model: string | undefined): string | undefined {
	const provider = model?.split(":")[0];
	const id = claudeAgentInstanceId(provider);
	if (!id) return undefined;
	const name = id.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
	return `${CLAUDE_AGENT_LABEL} · ${name}`;
}

function cleanPath(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sanitizeClaudeAgentSettings(raw: unknown): ClaudeAgentSettings {
	const list = raw && typeof raw === "object" && Array.isArray((raw as { instances?: unknown }).instances) ? (raw as { instances: unknown[] }).instances : [];
	const instances: ClaudeAgentInstance[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.trim() : "";
		if (!name) continue;
		const ids = instances.map((i) => i.id);
		const id = typeof e.id === "string" && SLUG.test(e.id) && !ids.includes(e.id) ? e.id : claudeAgentSlug(name, ids);
		const configDir = cleanPath(e.configDir), binaryPath = cleanPath(e.binaryPath);
		instances.push({ id, name, ...(configDir ? { configDir } : {}), ...(binaryPath ? { binaryPath } : {}), allowBackgroundUse: e.allowBackgroundUse === true });
	}
	return { instances };
}

export function claudeAgentLoginCommand(instance: Pick<ClaudeAgentInstance, "configDir" | "binaryPath">): string {
	const binary = instance.binaryPath ?? "claude";
	return instance.configDir ? `CLAUDE_CONFIG_DIR=${instance.configDir} ${binary}` : binary;
}
