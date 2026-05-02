import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export interface LoopbackHandle {
  port: number;
  token: string;
}

export type LoopbackError =
  | { kind: "dist-not-found"; searched: string[] }
  | { kind: "no-mcp-module"; distDir: string; candidates: string[] }
  | {
      kind: "module-import-failed";
      distDir: string;
      file: string;
      cause: string;
    }
  | {
      kind: "no-runtime-getter";
      distDir: string;
      file: string;
      exports: string[];
    }
  | {
      kind: "no-server-starter";
      distDir: string;
      file: string;
      asyncCandidatesTried: number;
    }
  | {
      kind: "runtime-shape-invalid";
      distDir: string;
      file: string;
      got: unknown;
    };

export type LoopbackResult =
  | { ok: true; source: "env" | "dist"; handle: LoopbackHandle }
  | { ok: false; error: LoopbackError };

const ENV_PORT = "__GLUECLAW_MCP_PORT";
const ENV_TOKEN = "__GLUECLAW_MCP_TOKEN";
const ENV_DIST_OVERRIDE = "OPENCLAW_DIST_DIR";
const MCP_FILE_PATTERN = /^mcp-http-[A-Za-z0-9_-]+\.js$/;
const MCP_FILE_MIN_BYTES = 2048;
const MCP_FILE_MARKERS = ["randomBytes", "createServer", "activeRuntime"];

let cached: LoopbackResult | undefined;
let inflight: Promise<LoopbackResult> | undefined;

export function resetOpenClawLoopbackCache(): void {
  cached = undefined;
  inflight = undefined;
}

export async function acquireOpenClawLoopback(): Promise<LoopbackResult> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const env = readEnvHandle();
    if (env) return (cached = { ok: true, source: "env", handle: env });
    const dist = await acquireFromDist();
    cached = dist;
    return dist;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

function readEnvHandle(): LoopbackHandle | undefined {
  const portStr = process.env[ENV_PORT];
  const token = process.env[ENV_TOKEN];
  if (!portStr || !token) return undefined;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return { port, token };
}

async function acquireFromDist(): Promise<LoopbackResult> {
  const distDirs = await findDistDirs();
  if (distDirs.length === 0) {
    return { ok: false, error: { kind: "dist-not-found", searched: [] } };
  }

  let lastError: LoopbackError | undefined;
  for (const distDir of distDirs) {
    const result = await tryDistDir(distDir);
    if (result.ok) return result;
    lastError = result.error;
  }
  return {
    ok: false,
    error: lastError ?? { kind: "dist-not-found", searched: distDirs },
  };
}

async function findDistDirs(): Promise<string[]> {
  const out = new Set<string>();

  const override = process.env[ENV_DIST_OVERRIDE];
  if (override && (await isDir(override))) out.add(override);

  for (const base of [process.cwd(), dirname(process.execPath)]) {
    const dir = await resolveOpenClawDist(base);
    if (dir) out.add(dir);
  }

  for (const p of (process.env.NODE_PATH ?? "").split(":")) {
    if (!p || !p.includes("openclaw")) continue;
    const dir = p.replace(/\/node_modules\/?$/, "/dist");
    if (await isDir(dir)) out.add(dir);
  }

  return [...out];
}

async function resolveOpenClawDist(from: string): Promise<string | undefined> {
  try {
    const req = createRequire(join(from, "_"));
    const pkgPath = req.resolve("openclaw/package.json");
    return join(dirname(pkgPath), "dist");
  } catch {
    return undefined;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function tryDistDir(distDir: string): Promise<LoopbackResult> {
  const candidates = await findMcpModuleFiles(distDir);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: { kind: "no-mcp-module", distDir, candidates: [] },
    };
  }

  let lastError: LoopbackError | undefined;
  for (const file of candidates) {
    const result = await tryMcpModule(distDir, file);
    if (result.ok) return result;
    lastError = result.error;
  }
  return {
    ok: false,
    error: lastError ?? { kind: "no-mcp-module", distDir, candidates },
  };
}

async function findMcpModuleFiles(distDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(distDir);
  } catch {
    return [];
  }

  const matches: Array<{ file: string; size: number }> = [];
  for (const entry of entries) {
    if (!MCP_FILE_PATTERN.test(entry)) continue;
    const full = join(distDir, entry);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      continue;
    }
    if (size < MCP_FILE_MIN_BYTES) continue;
    if (!hasMarkers(full)) continue;
    matches.push({ file: entry, size });
  }
  matches.sort((a, b) => b.size - a.size);
  return matches.map((m) => m.file);
}

function hasMarkers(path: string): boolean {
  try {
    const head = readFileSync(path, "utf8");
    return MCP_FILE_MARKERS.every((m) => head.includes(m));
  } catch {
    return false;
  }
}

async function tryMcpModule(
  distDir: string,
  file: string,
): Promise<LoopbackResult> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`file://${distDir}/${file}`)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "module-import-failed",
        distDir,
        file,
        cause: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const classified = classifyExports(mod);
  const getter = pickRuntimeGetter(classified.syncZeroArg);
  if (!getter) {
    return {
      ok: false,
      error: {
        kind: "no-runtime-getter",
        distDir,
        file,
        exports: Object.keys(mod),
      },
    };
  }

  const existing = safeCallGetter(getter);
  if (existing) {
    return { ok: true, source: "dist", handle: existing };
  }

  for (const candidate of classified.asyncZeroArg) {
    try {
      await candidate();
    } catch {
      continue;
    }
    const runtime = safeCallGetter(getter);
    if (runtime) {
      return { ok: true, source: "dist", handle: runtime };
    }
  }

  return {
    ok: false,
    error: {
      kind: "no-server-starter",
      distDir,
      file,
      asyncCandidatesTried: classified.asyncZeroArg.length,
    },
  };
}

interface Classified {
  syncZeroArg: Function[];
  asyncZeroArg: Function[];
}

function classifyExports(mod: Record<string, unknown>): Classified {
  const syncZeroArg: Function[] = [];
  const asyncZeroArg: Function[] = [];
  for (const v of Object.values(mod)) {
    if (typeof v !== "function") continue;
    const fn = v as Function;
    const isAsync = fn.constructor?.name === "AsyncFunction";
    if (fn.length !== 0) continue;
    if (isAsync) asyncZeroArg.push(fn);
    else syncZeroArg.push(fn);
  }
  return { syncZeroArg, asyncZeroArg };
}

function pickRuntimeGetter(
  candidates: Function[],
): (() => unknown) | undefined {
  for (const fn of candidates) {
    let result: unknown;
    try {
      result = (fn as () => unknown)();
    } catch {
      continue;
    }
    if (result === undefined || isLoopbackRuntime(result)) {
      return fn as () => unknown;
    }
  }
  return undefined;
}

function safeCallGetter(getter: () => unknown): LoopbackHandle | undefined {
  let result: unknown;
  try {
    result = getter();
  } catch {
    return undefined;
  }
  if (!isLoopbackRuntime(result)) return undefined;
  return { port: result.port, token: result.ownerToken };
}

function isLoopbackRuntime(
  x: unknown,
): x is { port: number; ownerToken: string } {
  if (x === null || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj["port"] === "number" &&
    (obj["port"] as number) > 0 &&
    typeof obj["ownerToken"] === "string" &&
    (obj["ownerToken"] as string).length > 0
  );
}

export function describeLoopbackError(err: LoopbackError): string {
  switch (err.kind) {
    case "dist-not-found":
      return `dist-not-found (searched ${err.searched.length} candidates)`;
    case "no-mcp-module":
      return `no-mcp-module in ${err.distDir} (matched ${err.candidates.length})`;
    case "module-import-failed":
      return `module-import-failed for ${err.file} in ${err.distDir}: ${err.cause}`;
    case "no-runtime-getter":
      return `no-runtime-getter in ${err.file} (exports=[${err.exports.join(",")}])`;
    case "no-server-starter":
      return `no-server-starter in ${err.file} (tried ${err.asyncCandidatesTried} async candidates)`;
    case "runtime-shape-invalid":
      return `runtime-shape-invalid in ${err.file}: got ${JSON.stringify(err.got)}`;
  }
}

export function writeMcpConfig(port: number): {
  path: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `glueclaw-mcp-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    path: configPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true });
      } catch {
        // Temp dir cleanup is best-effort
      }
    },
  };
}
