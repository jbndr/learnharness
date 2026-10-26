import path from "node:path";
import { sanitizeClaudeAgentSettings, type ClaudeAgentInstance, type ClaudeAgentView } from "../core/contracts/claude-agent.ts";
import { claudeAgentInstances, claudeAgentStatus, configureClaudeAgent, refreshClaudeAgent } from "../agent/claude-agent/registry.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

configureClaudeAgent(() => sanitizeClaudeAgentSettings(readSettings()?.claudeAgent).instances);

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 16384;

export function claudeAgentView(): ClaudeAgentView {
	const instances = claudeAgentInstances();
	return { instances, statuses: instances.flatMap((i) => claudeAgentStatus(i.id) ?? []) };
}

function binaryAllowed(binaryPath: string | undefined): boolean {
	if (!binaryPath) return true;
	const expanded = binaryPath.startsWith("~/") ? binaryPath.slice(2) : binaryPath;
	return (binaryPath.startsWith("~/") || path.isAbsolute(expanded)) && path.basename(expanded) === "claude";
}

function launchKey(i: ClaudeAgentInstance): string {
	return `${i.configDir ?? ""}\0${i.binaryPath ?? ""}`;
}

/** Replaces the instance list; instances whose account or binary changed are re-checked. */
export async function saveClaudeAgentInstances(raw: unknown): Promise<ClaudeAgentView> {
	const next = sanitizeClaudeAgentSettings(raw);
	const bad = next.instances.find((i) => !binaryAllowed(i.binaryPath));
	if (bad) throw new RangeError(`Binary path for "${bad.name}" must be an absolute path to a file named claude.`);
	const previous = new Map(claudeAgentInstances().map((i) => [i.id, launchKey(i)]));
	writeSettings({ ...readSettings(), claudeAgent: next });
	await Promise.all(next.instances.filter((i) => previous.get(i.id) !== launchKey(i)).map((i) => refreshClaudeAgent(i.id)));
	return claudeAgentView();
}

function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-claude-agent") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}

function error(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: HEADERS });
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
	const text = await request.text();
	if (text.length > MAX_BODY) return error("Request too large.", 413);
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error("Invalid request.", 400);
	return parsed as Record<string, unknown>;
}

export async function claudeAgentResponse(request: Request): Promise<Response> {
	if (!authorized(request)) return error("Claude Agent controls require a same-origin LearnHarness request.", 403);
	try {
		if (request.method === "GET") return Response.json(claudeAgentView(), { headers: HEADERS });
		const fields = await body(request);
		if (fields instanceof Response) return fields;
		if (request.method === "PUT") return Response.json(await saveClaudeAgentInstances(fields), { headers: HEADERS });
		if (request.method === "POST" && fields.op === "check" && typeof fields.id === "string") {
			if (!claudeAgentInstances().some((i) => i.id === fields.id)) return error("Unknown instance.", 404);
			await refreshClaudeAgent(fields.id);
			return Response.json(claudeAgentView(), { headers: HEADERS });
		}
		return error("Unsupported request.", 400);
	} catch (e) {
		return error(e instanceof RangeError ? e.message : "The Claude Agent settings could not be changed.", 400);
	}
}
