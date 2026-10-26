import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type PromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

const CLOSING = "Continue the conversation above as the assistant. Reply with your next message only, calling the available tools where appropriate.";

function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Renders a pi transcript (system messages excluded) as one user prompt. */
export function renderTranscript(messages: readonly Message[]): PromptBlock[] {
	const blocks: PromptBlock[] = [];
	let text = "<conversation>\n";
	const flush = () => {
		if (text) blocks.push({ type: "text", text });
		text = "";
	};
	const parts = (content: string | readonly (TextContent | ImageContent)[]) => {
		if (typeof content === "string") {
			text += content;
			return;
		}
		for (const part of content) {
			if (part.type === "text") text += part.text;
			else {
				flush();
				blocks.push({ type: "image", source: { type: "base64", media_type: part.mimeType as ImageMediaType, data: part.data } });
			}
		}
	};
	for (const message of messages) {
		if (message.role === "user") {
			text += "<user>\n";
			parts(message.content);
			text += "\n</user>\n";
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text) text += `<assistant>\n${part.text}\n</assistant>\n`;
				else if (part.type === "toolCall") text += `<tool_call id="${attr(part.id)}" name="${attr(part.name)}">\n${JSON.stringify(part.arguments)}\n</tool_call>\n`;
			}
		} else if (message.role === "toolResult") {
			text += `<tool_result id="${attr(message.toolCallId)}" name="${attr(message.toolName)}"${message.isError ? ' error="true"' : ""}>\n`;
			parts(message.content);
			text += "\n</tool_result>\n";
		}
	}
	text += `</conversation>\n\n${CLOSING}`;
	flush();
	return blocks;
}
