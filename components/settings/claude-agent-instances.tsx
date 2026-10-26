"use client";
import { useEffect, useState } from "react";
import { CLAUDE_AGENT_LABEL, claudeAgentLoginCommand, claudeAgentSlug, type ClaudeAgentInstance, type ClaudeAgentStatus, type ClaudeAgentView } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { CommitInput, Toggle } from "./controls";

const ENDPOINT = "/api/claude-agent";
const HEADERS = { "x-learnharness-claude-agent": "1" };

async function request(method: "GET" | "PUT" | "POST", body?: unknown): Promise<ClaudeAgentView> {
	const response = await fetch(ENDPOINT, {
		method,
		headers: body === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json = (await response.json()) as ClaudeAgentView & { error?: string };
	if (!response.ok) throw new Error(json.error ?? "Request failed.");
	return json;
}

function statusText(status: ClaudeAgentStatus | undefined): string {
	if (!status) return "Not checked yet";
	if (!status.ok) return status.error ?? "Not signed in";
	return [status.email, status.subscription, status.gateway && `Gateway · ${status.gateway}`].filter(Boolean).join(" · ") || "Signed in";
}

function InstanceRow({ instance, status, busy, onChange, onCheck, onRemove }: {
	instance: ClaudeAgentInstance;
	status: ClaudeAgentStatus | undefined;
	busy: boolean;
	onChange: (next: ClaudeAgentInstance) => void;
	onCheck: () => void;
	onRemove: () => void;
}) {
	const command = claudeAgentLoginCommand(instance);
	const [confirm, setConfirm] = useState(false);
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border/60 p-3" data-testid={`claude-agent-${instance.id}`}>
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-ui text-xs text-foreground">{CLAUDE_AGENT_LABEL} · {instance.name}</span>
				<span className={`min-w-0 truncate text-xs ${status && !status.ok ? "text-destructive" : "text-muted-foreground"}`} data-testid={`claude-agent-status-${instance.id}`}>{statusText(status)}</span>
				<span className="ml-auto flex items-center gap-1">
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={onCheck}>Check</Button>
					{confirm ? (
						<>
							<Button type="button" size="xs" variant="ghost" className="cursor-pointer text-destructive" disabled={busy} onClick={onRemove}>Remove</Button>
							<Button type="button" size="xs" variant="ghost" className="cursor-pointer" onClick={() => setConfirm(false)}>Keep</Button>
						</>
					) : (
						<Button type="button" size="xs" variant="ghost" className="cursor-pointer text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => setConfirm(true)}>Remove…</Button>
					)}
				</span>
			</div>
			<div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
				<span>Config dir</span>
				<CommitInput value={instance.configDir ?? ""} placeholder="~/.claude (default)" ariaLabel={`${instance.name} config dir`} onCommit={(v) => onChange({ ...instance, configDir: v || undefined })} />
				<span>Binary</span>
				<CommitInput value={instance.binaryPath ?? ""} placeholder="claude on PATH" ariaLabel={`${instance.name} binary path`} onCommit={(v) => onChange({ ...instance, binaryPath: v || undefined })} />
				<span>Background use</span>
				<span className="flex items-center gap-2">
					<Toggle checked={instance.allowBackgroundUse} disabled={busy} label={`${instance.name} background use`} onChange={(next) => onChange({ ...instance, allowBackgroundUse: next })} />
					<span className="text-muted-foreground/70">Helper agents, graph extraction and automatic follow-ups</span>
				</span>
				<span>Sign in</span>
				<span className="flex min-w-0 items-center gap-2">
					<code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono">{command}</code>
					<Button type="button" size="xs" variant="ghost" className="cursor-pointer" onClick={() => void navigator.clipboard?.writeText(command)}>Copy</Button>
					<span className="text-muted-foreground/70">then /login</span>
				</span>
			</div>
			{status?.ok && status.unmatched.length > 0 && (
				<p className="text-xs text-muted-foreground/70">Not offered (unknown to the model catalog): {status.unmatched.join(", ")}</p>
			)}
		</div>
	);
}

export function ClaudeAgentInstances() {
	const [view, setView] = useState<ClaudeAgentView>({ instances: [], statuses: [] });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState({ name: "", configDir: "", binaryPath: "" });

	useEffect(() => {
		let live = true;
		request("GET").then((v) => { if (live) setView(v); }, () => { if (live) setError("Claude Agent settings are unavailable."); });
		return () => { live = false; };
	}, []);

	async function run(action: () => Promise<ClaudeAgentView>) {
		setBusy(true);
		setError(null);
		try {
			setView(await action());
			notifySettingsSaved("keys");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Request failed.");
		} finally {
			setBusy(false);
		}
	}
	const save = (instances: ClaudeAgentInstance[]) => run(() => request("PUT", { instances }));
	const replace = (next: ClaudeAgentInstance) => save(view.instances.map((i) => (i.id === next.id ? next : i)));
	const add = () => {
		const name = draft.name.trim();
		if (!name) return;
		const instance: ClaudeAgentInstance = {
			id: claudeAgentSlug(name, view.instances.map((i) => i.id)),
			name,
			...(draft.configDir.trim() ? { configDir: draft.configDir.trim() } : {}),
			...(draft.binaryPath.trim() ? { binaryPath: draft.binaryPath.trim() } : {}),
			allowBackgroundUse: false,
		};
		void save([...view.instances, instance]).then(() => setDraft({ name: "", configDir: "", binaryPath: "" }));
	};
	const inputClass = "h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none";

	return (
		<div className="mt-2 flex flex-col gap-2" data-testid="claude-agent-section">
			<span className="font-ui text-xs text-foreground">{CLAUDE_AGENT_LABEL}</span>
			<p className="text-xs text-muted-foreground/70">Use your Claude subscriptions through your installed Claude. Each instance is one account, selected by its config directory. LearnHarness never sees your credentials.</p>
			{view.instances.map((instance) => (
				<InstanceRow
					key={instance.id}
					instance={instance}
					status={view.statuses.find((s) => s.id === instance.id)}
					busy={busy}
					onChange={replace}
					onCheck={() => void run(() => request("POST", { op: "check", id: instance.id }))}
					onRemove={() => void save(view.instances.filter((i) => i.id !== instance.id))}
				/>
			))}
			<div className="flex flex-wrap items-center gap-2">
				<input className={`${inputClass} w-28`} placeholder="Name" aria-label="New instance name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
				<input className={`${inputClass} w-44`} placeholder="Config dir (~/.claude)" aria-label="New instance config dir" value={draft.configDir} onChange={(e) => setDraft({ ...draft, configDir: e.target.value })} />
				<input className={`${inputClass} w-44`} placeholder="Binary (claude on PATH)" aria-label="New instance binary path" value={draft.binaryPath} onChange={(e) => setDraft({ ...draft, binaryPath: e.target.value })} />
				<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy || !draft.name.trim()} onClick={add} data-testid="claude-agent-add">Add instance</Button>
			</div>
			{error && <p className="text-xs text-destructive" role="alert">{error}</p>}
		</div>
	);
}
