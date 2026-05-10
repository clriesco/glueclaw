/**
 * Pick the most specific identity-bearing key OpenClaw exposed for this
 * conversation, so each conversation gets its own Claude CLI session.
 *
 * Precedence:
 *   1. `sessionKey` — semantic, stable across session resets for the same
 *      logical conversation (channel/group/sender-encoded). Best.
 *   2. `sessionId` — UUID of the current `<uuid>.jsonl` file. Rotates on reset.
 *   3. `agentDir` — collapses all conversations of one agent into one bucket.
 *      Used only when OpenClaw is older than openclaw/openclaw#73488 and
 *      doesn't propagate session identity to provider plugins.
 *   4. `"default"` — final safety net; should never hit in practice.
 */
export function resolveSessionKey(ctx: {
  sessionKey?: string;
  sessionId?: string;
  agentDir?: string;
}): string {
  const pick = (...candidates: Array<string | undefined>) => {
    for (const c of candidates) {
      const trimmed = c?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  };
  return pick(ctx.sessionKey, ctx.sessionId, ctx.agentDir) ?? "default";
}

/**
 * Derive the canonical OpenClaw session key for the current turn, so we
 * can advertise it to the gateway via the MCP `x-session-key` header
 * (which becomes `Agent 1 (requester) session: …` in the receiver's
 * `extraSystemPrompt`).
 *
 * OpenClaw 2026.4.x does not propagate the session key into the provider's
 * `streamFn(model, context, options)` call, so we recover it from
 * artifacts the gateway *does* leave in the prompt:
 *
 *   - **Inter-agent inbound (legacy spawn):** the system prompt is
 *     extended with an `Agent-to-agent message context` block whose
 *     `Agent 2 (target) session: agent:<id>:<chan>:…` line is literally
 *     this turn's session key. Use it verbatim.
 *
 *   - **agent-link inbound:** one of the trailing user messages starts
 *     with a header `[agent-link · from=<peer> · msgId=… · thread=<id>↔<peer>]`
 *     deterministically prepended by the agent-link plugin's runtime
 *     bridge (see agent-link `src/runtime-bridge.ts:buildBodyForAgent`).
 *     OpenClaw 2026.5.6+ may follow that body with one or more extra
 *     user messages (e.g. a `Conversation info` metadata block), so we
 *     scan every trailing user message — not just the last one — for
 *     the header. The peer in `from=` plus this agent's id reconstruct
 *     the canonical session key `agent:<agentId>:agent-link:direct:<peer>`.
 *     Without this branch the turn falls through to `agentDir`, sharing
 *     the agent's general-purpose Claude session and `--resume`-ing a
 *     polluted transcript (heartbeats, other channels) — Claude then
 *     replies with stale patterns instead of treating the agent-link
 *     message on its own merits.
 *
 *   - **Channel inbound (Telegram):** the most recent user message
 *     starts with a `Conversation info` JSON block carrying
 *     `"chat_id": "<channel>:<id>"`. Construct
 *     `agent:<agentId>:<channel>:<kind>:<id>` from it. Telegram
 *     convention: positive id → `direct`, `-100…` → `supergroup`,
 *     other negative → `group`.
 *
 *   - Otherwise: return undefined and let callers fall back to the
 *     registration-time key (path-based `agentDir`).
 */
export function deriveTurnSessionKey(params: {
  agentId?: string;
  systemPrompt?: string;
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) return undefined;

  const sp = params.systemPrompt ?? "";
  const targetMatch = sp.match(
    new RegExp(
      `Agent 2 \\(target\\) session:\\s*(agent:${escapeRegExp(agentId)}:[^.\\s]+)`,
    ),
  );
  if (targetMatch) return targetMatch[1];

  // OpenClaw 2026.5.6+ may split a turn into multiple consecutive user
  // messages (the actual body, plus a `Conversation info` metadata block).
  // We scan every trailing user message for the agent-link header before
  // falling through to the chat_id-based Telegram match. The Telegram
  // chat_id JSON typically lives in the trailing metadata block, while the
  // agent-link header sits at the start of the body block — so we look at
  // both sides instead of just the last message.
  const trailingTexts = extractTrailingUserTexts(params.messages);
  for (const text of trailingTexts) {
    const agentLinkMatch = text.match(
      /^\[agent-link\b[^\]]*\bfrom=([A-Za-z0-9_-]+)/,
    );
    if (agentLinkMatch) {
      return `agent:${agentId}:agent-link:direct:${agentLinkMatch[1]}`;
    }
  }

  for (const text of trailingTexts) {
    const chatMatch = text.match(/"chat_id"\s*:\s*"([a-z]+):(-?\d+)"/i);
    if (chatMatch) {
      const channel = chatMatch[1].toLowerCase();
      const rawId = chatMatch[2];
      const { kind, id } = classifyChatId(rawId);
      return `agent:${agentId}:${channel}:${kind}:${id}`;
    }
  }

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractUserTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const txt = content
      .filter(
        (b: unknown): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
    return txt || undefined;
  }
  return undefined;
}

function extractLastUserText(
  messages: Array<{ role: string; content: unknown }> | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const txt = extractUserTextFromContent(m.content);
    if (txt) return txt;
  }
  return undefined;
}

/**
 * Collect the text of every user message in the trailing run of consecutive
 * user-role messages, ordered oldest-to-newest. OpenClaw 2026.5.6+ may
 * split a single turn into multiple user messages (e.g. the inbound body
 * plus a `Conversation info` metadata block). Both the agent-link header
 * (in the body) and the Telegram `chat_id` JSON (in the metadata) need to
 * be discoverable, so we expose every trailing user-message text rather
 * than just the last one.
 */
function extractTrailingUserTexts(
  messages: Array<{ role: string; content: unknown }> | undefined,
): string[] {
  if (!messages) return [];
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") break;
    const txt = extractUserTextFromContent(m.content);
    if (txt) trailing.unshift(txt);
  }
  return trailing;
}

function classifyChatId(raw: string): { kind: string; id: string } {
  if (!raw.startsWith("-")) return { kind: "direct", id: raw };
  if (raw.startsWith("-100")) return { kind: "supergroup", id: raw.slice(4) };
  return { kind: "group", id: raw.slice(1) };
}
