import { basename } from "node:path";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createClaudeCliStreamFn,
  listSessions,
  dropSession,
  flushSession,
} from "./src/stream.js";
import { MODEL_CATALOG } from "./src/catalog.js";
import { resolveSessionKey } from "./src/session-key.js";

const PROVIDER_ID = "glueclaw";
const PROVIDER_LABEL = "GlueClaw";
const BASE_URL = "local://glueclaw";
const API_FORMAT = "anthropic-messages";
const AUTH_KEY = "glueclaw-local";
const AUTH_SOURCE = "claude CLI (local auth)";

const MODEL_MAP: Readonly<Record<string, string>> = {
  "glueclaw-opus": "claude-opus-4-6",
  "glueclaw-sonnet": "claude-sonnet-4-6",
  "glueclaw-haiku": "claude-haiku-4-5",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function resolveRequestTimeoutMs(): number {
  const raw = process.env.GLUECLAW_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_REQUEST_TIMEOUT_MS;
  return parsed;
}

export default definePluginEntry({
  register(api: OpenClawPluginApi): void {
    const authProfile = () =>
      ({
        apiKey: AUTH_KEY,
        source: AUTH_SOURCE,
        mode: "api-key" as const,
      }) as const;

    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      aliases: ["sc"],
      envVars: ["GLUECLAW_KEY"],
      auth: [
        {
          id: "local",
          method: "local",
          label: "Local Claude CLI",
          hint: "Uses your locally installed claude binary",
          authenticate: async () => authProfile(),
          authenticateNonInteractive: async () => authProfile(),
        },
      ],
      catalog: {
        run: async () => ({
          provider: {
            baseUrl: BASE_URL,
            api: API_FORMAT,
            models: [
              {
                id: "glueclaw-opus",
                name: "GlueClaw Opus",
                contextWindow: 1_000_000,
                maxTokens: 32_000,
              },
              {
                id: "glueclaw-sonnet",
                name: "GlueClaw Sonnet",
                contextWindow: 1_000_000,
                maxTokens: 16_000,
              },
              {
                id: "glueclaw-haiku",
                name: "GlueClaw Haiku",
                contextWindow: 200_000,
                maxTokens: 8_000,
              },
            ],
          },
        }),
      },
      createStreamFn: (ctx: {
        modelId: string;
        agentDir?: string;
        sessionId?: string;
        sessionKey?: string;
      }) => {
        const realModel = MODEL_MAP[ctx.modelId] ?? ctx.modelId;
        const agentId = ctx.agentDir ? basename(ctx.agentDir) : undefined;
        return createClaudeCliStreamFn({
          sessionKey: resolveSessionKey(ctx),
          agentId,
          modelOverride: realModel,
          requestTimeoutMs: resolveRequestTimeoutMs(),
        });
      },
      resolveSyntheticAuth: () => ({
        apiKey: AUTH_KEY,
        source: AUTH_SOURCE,
        mode: "api-key",
      }),
      augmentModelCatalog: () => [...MODEL_CATALOG],
    });

    // Subscribe to session_end: when openclaw resets a session (reason="reset"
    // or "new") or deletes it ("deleted"), flush our in-memory mapping and
    // archive the underlying claude CLI transcript. Other reasons (idle,
    // daily, compaction) are normal lifecycle rotations where we want to keep
    // the claude session alive across them.
    const FLUSH_REASONS = new Set(["reset", "new", "deleted"]);
    api.on?.("session_end", (event) => {
      if (!event.sessionKey) return;
      if (!event.reason || !FLUSH_REASONS.has(event.reason)) return;
      const result = flushSession(event.sessionKey);
      if (result.droppedKey || result.archivedPath) {
        process.stderr.write(
          `[GC-RESET] session_end reason=${event.reason} key=${event.sessionKey} dropped=${result.droppedKey} archived=${result.archivedPath ?? "(none)"}\n`,
        );
      }
    });

    // RPC surface for manual ops (skills, crons, debug). Operator scope by
    // default — only the gateway's authenticated operator can call these.
    api.registerGatewayMethod?.(
      "glueclaw.listSessions",
      async (opts) => {
        const o = opts as unknown as {
          respond: (
            ok: boolean,
            payload?: unknown,
            error?: { code?: string; message?: string },
          ) => void;
        };
        o.respond(true, { sessions: listSessions() });
      },
    );

    api.registerGatewayMethod?.(
      "glueclaw.dropSession",
      async (opts) => {
        const o = opts as unknown as {
          params?: Record<string, unknown>;
          respond: (
            ok: boolean,
            payload?: unknown,
            error?: { code?: string; message?: string },
          ) => void;
        };
        const sessionKey = (o.params?.sessionKey ?? o.params?.key) as
          | string
          | undefined;
        if (!sessionKey) {
          o.respond(false, undefined, {
            code: "invalid-params",
            message: "glueclaw.dropSession: sessionKey is required",
          });
          return;
        }
        o.respond(true, { dropped: dropSession(sessionKey) });
      },
    );

    api.registerGatewayMethod?.(
      "glueclaw.flushSession",
      async (opts) => {
        const o = opts as unknown as {
          params?: Record<string, unknown>;
          respond: (
            ok: boolean,
            payload?: unknown,
            error?: { code?: string; message?: string },
          ) => void;
        };
        const sessionKey = (o.params?.sessionKey ?? o.params?.key) as
          | string
          | undefined;
        if (!sessionKey) {
          o.respond(false, undefined, {
            code: "invalid-params",
            message: "glueclaw.flushSession: sessionKey is required",
          });
          return;
        }
        o.respond(true, flushSession(sessionKey));
      },
    );
  },
});
