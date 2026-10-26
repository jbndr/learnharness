import type { Api, Model } from "@earendil-works/pi-ai";

export interface SupportedModel {
	value: string;
	resolvedModel?: string;
}

export interface MappedModels {
	/** Catalog id → the value Claude expects for `model`. */
	models: Map<string, string>;
	unmatched: string[];
}

/** Maps Claude's model list onto catalog ids; aliases like "default" collapse into their resolved id. */
export function mapSupportedModels(infos: readonly SupportedModel[], catalogIds: ReadonlySet<string>): MappedModels {
	const models = new Map<string, string>();
	const unmatched: string[] = [];
	for (const info of infos) {
		if (info.value === "default") continue;
		const id = info.resolvedModel ?? info.value;
		if (!catalogIds.has(id)) {
			if (!unmatched.includes(id)) unmatched.push(id);
			continue;
		}
		const current = models.get(id);
		if (!current || (!current.startsWith("claude-") && info.value.startsWith("claude-"))) models.set(id, info.value);
	}
	return { models, unmatched };
}

export function asClaudeAgentModel(base: Model<Api>, provider: string): Model<Api> {
	return { ...base, provider, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
