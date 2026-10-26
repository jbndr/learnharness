import type { Api, Model } from "@earendil-works/pi-ai";
import { claudeAgentInstanceId, claudeAgentProviderId, type ClaudeAgentInstance, type ClaudeAgentStatus } from "../../core/contracts/claude-agent.ts";
import { piModels } from "../models.ts";
import { asClaudeAgentModel, mapSupportedModels } from "./models.ts";
import { inspectClaudeAgent, type QueryFn } from "./sdk.ts";

const CATALOG_PROVIDER = "anthropic";

interface State {
	source: () => ClaudeAgentInstance[];
	statuses: Map<string, ClaudeAgentStatus>;
	sdkModels: Map<string, Map<string, string>>;
	inflight: Map<string, Promise<ClaudeAgentStatus>>;
	run?: QueryFn;
}

// Survives Next dev module reloads, like the other connection bridges.
const KEY = Symbol.for("lh.claude-agent.registry");
function state(): State {
	const g = globalThis as unknown as Record<symbol, State | undefined>;
	return (g[KEY] ??= { source: () => [], statuses: new Map(), sdkModels: new Map(), inflight: new Map() });
}

export function configureClaudeAgent(source: () => ClaudeAgentInstance[], run?: QueryFn): void {
	const s = state();
	s.source = source;
	s.run = run;
}

export function claudeAgentInstances(): ClaudeAgentInstance[] {
	return state().source();
}

export function claudeAgentInstance(provider: string | undefined): ClaudeAgentInstance | undefined {
	const id = claudeAgentInstanceId(provider);
	return id ? claudeAgentInstances().find((i) => i.id === id) : undefined;
}

export function claudeAgentStatus(instanceId: string): ClaudeAgentStatus | undefined {
	return state().statuses.get(instanceId);
}

/** Unchecked instances count as connected; a failed check does not. */
export function claudeAgentConnected(provider: string): boolean {
	const instance = claudeAgentInstance(provider);
	return !!instance && claudeAgentStatus(instance.id)?.ok !== false;
}

export function claudeAgentBackgroundAllowed(provider: string): boolean {
	return claudeAgentInstance(provider)?.allowBackgroundUse === true;
}

function catalogIds(): Set<string> {
	return new Set(piModels().getModels(CATALOG_PROVIDER).map((m) => m.id));
}

export function refreshClaudeAgent(instanceId: string): Promise<ClaudeAgentStatus> {
	const s = state();
	const pending = s.inflight.get(instanceId);
	if (pending) return pending;
	const task = (async (): Promise<ClaudeAgentStatus> => {
		const instance = claudeAgentInstances().find((i) => i.id === instanceId);
		const checkedAt = new Date().toISOString();
		let status: ClaudeAgentStatus;
		if (!instance) status = { id: instanceId, ok: false, checkedAt, models: [], unmatched: [], error: "Unknown instance" };
		else {
			try {
				const info = await inspectClaudeAgent(instance, s.run);
				const mapped = mapSupportedModels(info.models, catalogIds());
				s.sdkModels.set(instanceId, mapped.models);
				const signedIn = !!(info.email || info.subscription || info.gateway);
				status = {
					id: instanceId,
					ok: signedIn,
					checkedAt,
					...(info.email ? { email: info.email } : {}),
					...(info.subscription ? { subscription: info.subscription } : {}),
					...(info.gateway ? { gateway: info.gateway } : {}),
					models: [...mapped.models.keys()],
					unmatched: mapped.unmatched,
					...(signedIn ? {} : { error: "Not signed in" }),
				};
			} catch (error) {
				status = { id: instanceId, ok: false, checkedAt, models: [], unmatched: [], error: error instanceof Error ? error.message : String(error) };
			}
		}
		s.statuses.set(instanceId, status);
		return status;
	})().finally(() => s.inflight.delete(instanceId));
	s.inflight.set(instanceId, task);
	return task;
}

/** Checks instances that have never been checked (or every instance when forced). */
export async function refreshClaudeAgents(instanceId?: string, force = false): Promise<void> {
	const ids = claudeAgentInstances().map((i) => i.id).filter((id) => !instanceId || id === instanceId);
	await Promise.all(ids.filter((id) => force || !state().statuses.has(id)).map((id) => refreshClaudeAgent(id)));
}

export function claudeAgentModel(provider: string, id: string): Model<Api> | undefined {
	if (!claudeAgentInstance(provider)) return undefined;
	const base = piModels().getModel(CATALOG_PROVIDER, id);
	return base ? asClaudeAgentModel(base, provider) : undefined;
}

/** Models of every successfully checked instance, for the picker. */
export function claudeAgentModels(): Model<Api>[] {
	return claudeAgentInstances().flatMap((instance) => {
		const status = claudeAgentStatus(instance.id);
		if (!status?.ok) return [];
		const provider = claudeAgentProviderId(instance.id);
		return status.models.flatMap((id) => {
			const model = claudeAgentModel(provider, id);
			return model ? [model] : [];
		});
	});
}

export function claudeAgentProviders(): string[] {
	return claudeAgentInstances().map((i) => claudeAgentProviderId(i.id));
}

/** The value to pass as the SDK `model` (e.g. a 1M-context alias), falling back to the catalog id. */
export function claudeAgentSdkModel(instanceId: string, id: string): string {
	return state().sdkModels.get(instanceId)?.get(id) ?? id;
}
