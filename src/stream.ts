import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage, TextContent } from "@mariozechner/pi-ai";
import { deriveTurnSessionKey } from "./session-key.js";
import {
  acquireOpenClawLoopback,
  describeLoopbackError,
  writeMcpConfig,
} from "./openclaw-loopback.js";

const PROCESS_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_SESSIONS = 1000;

/** Max size for a claude session JSONL before the resume watchdog archives it.
 *  Override with GLUECLAW_MAX_JSONL_MB (positive number, MB). Default 5 MB. */
const MAX_RESUME_BYTES = (() => {
  const raw = process.env.GLUECLAW_MAX_JSONL_MB;
  const parsed = raw === undefined || raw === "" ? 5 : Number(raw);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  return mb * 1024 * 1024;
})();

/** Shape of NDJSON stream events from the Claude CLI. */
interface StreamEventData {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  usage?: Record<string, number>;
  event?: {
    delta?: { type?: string; text?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
}

/** Track claude session IDs per session key for multi-turn resume.
 *  Persisted to disk so sessions survive gateway restarts. */
const GC_HOME = join(process.env.HOME ?? tmpdir(), ".glueclaw");
const SESSION_FILE = join(GC_HOME, "sessions.json");
const sessionMap = new Map<string, string>();

// Load persisted sessions on startup
try {
  const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  for (const [k, v] of Object.entries(saved)) {
    if (typeof v === "string") sessionMap.set(k, v);
  }
} catch {
  // Expected on first run when session file doesn't exist
}

export function persistSessions(): void {
  try {
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessionMap)));
    renameSync(tmp, SESSION_FILE); // Atomic on most filesystems
  } catch {
    // Best-effort persistence — non-fatal if disk write fails
  }
}

/** Slugify a directory path the way the claude CLI names per-project session dirs.
 *  Example: '/home/pacolobo/.glueclaw' -> '-home-pacolobo--glueclaw'. */
function claudeProjectSlug(cwd: string): string {
  return "-" + cwd.replace(/^\/+/, "").replace(/[\/.]/g, "-");
}

const CLAUDE_PROJECT_DIR = join(
  process.env.HOME ?? tmpdir(),
  ".claude",
  "projects",
  claudeProjectSlug(GC_HOME),
);

/** Resolve the on-disk claude CLI session transcript for a given session UUID. */
export function claudeSessionJsonlPath(sessionId: string): string {
  return join(CLAUDE_PROJECT_DIR, `${sessionId}.jsonl`);
}

/** Normalize a sessionKey: glueclaw stores keys with the 'glueclaw:' prefix. */
function normalizeSessionKey(key: string): string {
  return key.startsWith("glueclaw:") ? key : `glueclaw:${key}`;
}

/** Snapshot of the in-memory session map. For inspection / health endpoints. */
export function listSessions(): Record<string, string> {
  return Object.fromEntries(sessionMap);
}

/** Remove the in-memory mapping for a session key and persist the change.
 *  Does NOT touch the underlying claude CLI transcript. Use flushSession for that. */
export function dropSession(sessionKey: string): boolean {
  const key = normalizeSessionKey(sessionKey);
  const had = sessionMap.has(key);
  if (had) {
    sessionMap.delete(key);
    persistSessions();
  }
  return had;
}

/** Drop the mapping AND archive the underlying claude CLI transcript so the
 *  next turn for this key starts a fresh session UUID. Idempotent. */
export function flushSession(sessionKey: string): {
  droppedKey: boolean;
  archivedPath: string | null;
  uuid: string | null;
} {
  const key = normalizeSessionKey(sessionKey);
  const uuid = sessionMap.get(key) ?? null;
  let archivedPath: string | null = null;
  if (uuid) {
    const jsonl = claudeSessionJsonlPath(uuid);
    if (existsSync(jsonl)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = `${jsonl}.archived.${ts}`;
      try {
        renameSync(jsonl, dest);
        archivedPath = dest;
      } catch {
        // Best-effort — proceed with dropping the in-memory mapping anyway.
      }
    }
  }
  const droppedKey = dropSession(key);
  return { droppedKey, archivedPath, uuid };
}

export function buildUsage(raw?: Record<string, number>): Usage {
  return {
    input: raw?.input_tokens ?? 0,
    output: raw?.output_tokens ?? 0,
    cacheRead: raw?.cache_read_input_tokens ?? 0,
    cacheWrite: raw?.cache_creation_input_tokens ?? 0,
    totalTokens:
      (raw?.input_tokens ?? 0) +
      (raw?.output_tokens ?? 0) +
      (raw?.cache_creation_input_tokens ?? 0) +
      (raw?.cache_read_input_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildMsg(
  model: { api: string; provider: string; id: string },
  text: string,
  usage: Usage,
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  };
}

/** Scrub Anthropic detection triggers from system prompts. */
export function scrubPrompt(input: string): string {
  return input
    .replace(
      /personal assistant running inside OpenClaw/g,
      "personal assistant running inside GlueClaw",
    )
    .replace(/HEARTBEAT_OK/g, "GLUECLAW_ACK")
    .replace(/reply_to_current/g, "reply_current")
    .replace(/\[\[reply_to:/g, "[[reply:")
    .replace(/openclaw\.inbound_meta/g, "glueclaw.inbound_meta")
    .replace(/generated by OpenClaw/g, "generated by GlueClaw");
}

/** Reverse scrub translations in response text for the gateway. */
export function unscrubResponse(text: string): string {
  return text
    .replace(/GLUECLAW_ACK/g, "HEARTBEAT_OK")
    .replace(/reply_current/g, "reply_to_current")
    .replace(/\[\[reply:/g, "[[reply_to:");
}

/** Evict oldest sessions when map exceeds MAX_SESSIONS */
function evictSessions(): void {
  while (sessionMap.size > MAX_SESSIONS) {
    const oldest = sessionMap.keys().next().value;
    if (oldest !== undefined) sessionMap.delete(oldest);
    else break;
  }
}

export function createClaudeCliStreamFn(opts: {
  claudeBin?: string;
  sessionKey?: string;
  agentId?: string;
  modelOverride?: string;
  requestTimeoutMs?: number;
}): StreamFn {
  const claudeBin = opts.claudeBin ?? "claude";
  const requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      let mcpCleanup: (() => void) | undefined;
      let stderrBuf = "";
      try {
        const turnSessionKey = deriveTurnSessionKey({
          agentId: opts.agentId,
          systemPrompt: context.systemPrompt,
          messages: context.messages as
            | Array<{ role: string; content: unknown }>
            | undefined,
        });
        const effectiveSessionKey =
          turnSessionKey ?? opts.sessionKey ?? "default";
        // [GC-DBG] temporary diagnostics — remove once stamping is reconfirmed end-to-end.
        const _dbgIncomingRequester =
          (context.systemPrompt ?? "").match(
            /Agent 1 \(requester\) session:\s*([^\s.]+)/,
          )?.[1] ?? "(none)";
        const _dbgHasA2A = /Agent-to-agent message context/.test(
          context.systemPrompt ?? "",
        );
        process.stderr.write(
          `[GC-DBG] agent=${opts.agentId ?? "(none)"} effectiveSessionKey=${effectiveSessionKey} derivedFrom=${turnSessionKey ? "derived" : "fallback"} incomingRequester=${_dbgIncomingRequester} hasA2ABlock=${_dbgHasA2A}\n`,
        );
        // Scrub Anthropic detection triggers (see docs/detection-patterns.md)
        const cleanPrompt = scrubPrompt(context.systemPrompt ?? "");
        const resolvedModel = opts.modelOverride ?? model.id;
        const args = [
          "--dangerously-skip-permissions",
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
        ];
        // Resume session for multi-turn conversation memory.
        // Always re-inject the system prompt — on resumptions the CLI would
        // otherwise stick to whatever identity was used on the first turn,
        // leaving no way for callers to reinforce or correct an agent's
        // identity across turns.
        const sessionKey = `glueclaw:${effectiveSessionKey}`;
        const existingSessionId = sessionMap.get(sessionKey);
        if (existingSessionId) {
          // Resume watchdog: skip --resume (and force a fresh session) when the
          // transcript is either bloated past MAX_RESUME_BYTES (prefill races
          // the LLM idle timeout) or missing entirely (phantom mapping from a
          // prior failed turn — --resume to a non-existent file produces
          // "(no response)" with 0 tokens).
          const jsonl = claudeSessionJsonlPath(existingSessionId);
          let size = -1;
          try {
            size = statSync(jsonl).size;
          } catch {
            size = -1; // missing
          }
          if (size < 0) {
            process.stderr.write(
              `[GC-WATCHDOG] phantom mapping (jsonl missing) key=${sessionKey} uuid=${existingSessionId} — dropping mapping, starting fresh\n`,
            );
            dropSession(sessionKey);
          } else if (size > MAX_RESUME_BYTES) {
            process.stderr.write(
              `[GC-WATCHDOG] bloated transcript key=${sessionKey} uuid=${existingSessionId} size=${size} max=${MAX_RESUME_BYTES} — archiving, starting fresh\n`,
            );
            flushSession(sessionKey);
          } else {
            args.push("--resume", existingSessionId);
          }
        }
        if (cleanPrompt) args.push("--system-prompt", cleanPrompt);
        if (resolvedModel) args.push("--model", resolvedModel);

        // OpenClaw 2026.5.6+ may split a turn into multiple consecutive user
        // messages (e.g. the actual text plus a metadata block). Concatenate
        // every trailing user message so nothing the user said is dropped.
        const messages = context.messages ?? [];
        const trailingUsers: typeof messages = [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m || m.role !== "user") break;
          trailingUsers.unshift(m);
        }
        const extractText = (c: unknown): string => {
          if (typeof c === "string") return c;
          if (Array.isArray(c))
            return c
              .filter((b): b is TextContent => b?.type === "text")
              .map((b) => b.text)
              .join("\n");
          return "";
        };
        const prompt = trailingUsers
          .map((m) => extractText(m.content))
          .filter((t) => t.length > 0)
          .join("\n\n");
        if (prompt) args.push(prompt);

        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_API_KEY_OLD;

        // Wire up MCP bridge for OpenClaw gateway tools
        const loopback = await acquireOpenClawLoopback();
        if (loopback.ok) {
          process.stderr.write(
            `[GC-DBG] mcpLoopback=port=${loopback.handle.port} via=${loopback.source}\n`,
          );
          const mcp = writeMcpConfig(loopback.handle.port);
          mcpCleanup = mcp.cleanup;
          args.push("--strict-mcp-config", "--mcp-config", mcp.path);
          env.OPENCLAW_MCP_TOKEN = loopback.handle.token;
          env.OPENCLAW_MCP_SESSION_KEY = effectiveSessionKey;
          env.OPENCLAW_MCP_AGENT_ID = opts.agentId ?? "main";
          env.OPENCLAW_MCP_ACCOUNT_ID = "";
          env.OPENCLAW_MCP_MESSAGE_CHANNEL = "";
        } else {
          process.stderr.write(
            `[GC-DBG] mcpLoopback=UNAVAILABLE reason=${describeLoopbackError(loopback.error)}\n`,
          );
        }

        // Use persistent dir so claude sessions survive restarts
        const gcHome = join(process.env.HOME ?? "/tmp", ".glueclaw");
        mkdirSync(gcHome, { recursive: true });
        const proc = spawn(claudeBin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: gcHome,
          env,
        });
        if (options?.signal)
          options.signal.addEventListener("abort", () => proc.kill("SIGTERM"));

        // Capture stderr for diagnostics
        if (proc.stderr) {
          proc.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
          });
        }

        // Request timeout — kill process if it takes too long
        const requestTimer = setTimeout(() => {
          if (!ended) {
            proc.kill("SIGTERM");
            setTimeout(() => {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* already dead */
              }
            }, PROCESS_TIMEOUT_MS);
          }
        }, requestTimeout);

        const info = {
          api: String(model.api ?? "anthropic-messages"),
          provider: String(model.provider ?? "glueclaw"),
          id: String(model.id),
        };
        let text = "";
        let started = false;
        let ended = false;

        const startStream = () => {
          if (started) return;
          started = true;
          const p = buildMsg(info, "", buildUsage());
          stream.push({ type: "start", partial: p });
          stream.push({ type: "text_start", contentIndex: 0, partial: p });
        };

        let streamed = false; // true if text was delivered via text_delta events

        const endStream = (usage?: Record<string, number>) => {
          if (ended) return;
          ended = true;
          // Translate renamed tokens back for the gateway
          // Skip if streaming deltas already unscrubbed each chunk
          if (!streamed) text = unscrubResponse(text);
          if (started && !streamed) {
            // Only emit text_end if text wasn't already delivered via streaming deltas
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: text,
              partial: buildMsg(info, text, buildUsage(usage)),
            });
          }
          stream.push({
            type: "done",
            reason: "stop",
            message: buildMsg(info, text || "(no response)", buildUsage(usage)),
          });
        };

        const rl = createInterface({ input: proc.stdout! });

        for await (const line of rl) {
          if (!line.trim()) continue;
          let data: StreamEventData;
          try {
            data = JSON.parse(line) as StreamEventData;
          } catch {
            // Skip malformed NDJSON lines
            continue;
          }

          const type = data.type;

          // Capture session ID for resume
          if (type === "system" && data.subtype === "init") {
            const sid = data.session_id;
            if (sid) {
              sessionMap.set(sessionKey, sid);
              evictSessions();
              persistSessions();
            }
            continue;
          }

          // Stream text deltas
          if (type === "stream_event") {
            const delta = data.event?.delta;
            if (delta?.type === "text_delta" && delta.text) {
              startStream();
              streamed = true;
              // Translate renamed tokens back in streaming deltas
              const dt = unscrubResponse(delta.text);
              text += dt;
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta: dt,
                partial: buildMsg(info, text, buildUsage()),
              });
            }
            continue;
          }

          // Assistant message — may contain tool_use and/or text content blocks
          if (type === "assistant") {
            const content = data.message?.content;
            if (content) {
              // Emit tool call events for any tool_use blocks
              for (const block of content) {
                if (block.type === "tool_use") {
                  const b = block as {
                    type: string;
                    id: string;
                    name: string;
                    input: Record<string, unknown>;
                  };
                  startStream();
                  const toolCall = {
                    type: "toolCall" as const,
                    id: b.id,
                    name: b.name,
                    arguments: (b.input ?? {}) as Record<string, any>,
                  };
                  stream.push({
                    type: "toolcall_start",
                    contentIndex: 0,
                    toolName: b.name,
                    partial: buildMsg(info, text, buildUsage()),
                  } as any);
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: 0,
                    toolCall,
                    partial: buildMsg(info, text, buildUsage()),
                  });
                }
              }

              // Handle text blocks (only if we haven't streamed via deltas)
              if (!streamed) {
                const textBlocks = content
                  .filter((b: any) => b.type === "text" && b.text)
                  .map((b: any) => b.text ?? "");
                if (textBlocks.length > 0) {
                  const fullText = textBlocks.join("\n");
                  startStream();
                  text = fullText;
                  stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: fullText,
                    partial: buildMsg(info, text, buildUsage()),
                  });
                }
              }
            }
            continue;
          }

          // Result event (final) - authoritative response
          if (type === "result") {
            const sid = data.session_id;
            if (sid) {
              sessionMap.set(sessionKey, sid);
              evictSessions();
              persistSessions();
            }
            // Only use result text if nothing came through streaming or assistant
            if (!text) {
              const resultText = data.result;
              if (resultText) {
                startStream();
                text = resultText;
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: text,
                  partial: buildMsg(info, text, buildUsage()),
                });
              }
            }
            endStream(data.usage);
            rl.close();
            proc.kill("SIGTERM");
            break;
          }
        }

        // Wait for process exit with timeout
        clearTimeout(requestTimer);
        await Promise.race([
          new Promise<void>((r) => proc.on("close", () => r())),
          new Promise<void>((r) => setTimeout(r, PROCESS_TIMEOUT_MS)),
        ]);
        // SIGKILL fallback if process didn't exit after SIGTERM
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        if (!ended) endStream();
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildMsg(
            {
              api: String(model.api ?? "anthropic-messages"),
              provider: "glueclaw",
              id: String(model.id),
            },
            `Error: ${err instanceof Error ? err.message : String(err)}${stderrBuf ? "\nstderr: " + stderrBuf.trim() : ""}`,
            buildUsage(),
          ),
        });
      } finally {
        mcpCleanup?.();
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
