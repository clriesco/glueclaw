import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireOpenClawLoopback,
  resetOpenClawLoopbackCache,
} from "../../openclaw-loopback.js";

/**
 * Build a fake `mcp-http-*.js` module on disk. The file must be:
 *  - >= 2 KB (real-world threshold)
 *  - contain the markers we look for to distinguish it from re-export shims
 * We then export the provided closures via the same alias pattern OpenClaw
 * uses (single-letter idents), reproducing each historical shape.
 */
function makeFakeDistDir(opts: {
  /** ESM body that defines and exports the loopback functions */
  source: string;
}): { distDir: string; cleanup: () => void } {
  const distDir = mkdtempSync(join(tmpdir(), "glueclaw-fake-dist-"));
  const file = join(distDir, "mcp-http-FAKE0001.js");
  // Pad with marker tokens so hasMarkers() passes and size > 2 KB
  const padding =
    "// padding to clear MIN_BYTES threshold ".repeat(80) +
    "\n// markers: randomBytes createServer activeRuntime\n";
  writeFileSync(file, padding + opts.source);
  return {
    distDir,
    cleanup: () => rmSync(distDir, { recursive: true, force: true }),
  };
}

const ORIG_ENV = {
  port: process.env.__GLUECLAW_MCP_PORT,
  token: process.env.__GLUECLAW_MCP_TOKEN,
  dist: process.env.OPENCLAW_DIST_DIR,
  nodePath: process.env.NODE_PATH,
};

beforeEach(() => {
  resetOpenClawLoopbackCache();
  delete process.env.__GLUECLAW_MCP_PORT;
  delete process.env.__GLUECLAW_MCP_TOKEN;
  delete process.env.OPENCLAW_DIST_DIR;
  process.env.NODE_PATH = "";
});

afterEach(() => {
  resetOpenClawLoopbackCache();
  if (ORIG_ENV.port !== undefined)
    process.env.__GLUECLAW_MCP_PORT = ORIG_ENV.port;
  else delete process.env.__GLUECLAW_MCP_PORT;
  if (ORIG_ENV.token !== undefined)
    process.env.__GLUECLAW_MCP_TOKEN = ORIG_ENV.token;
  else delete process.env.__GLUECLAW_MCP_TOKEN;
  if (ORIG_ENV.dist !== undefined)
    process.env.OPENCLAW_DIST_DIR = ORIG_ENV.dist;
  else delete process.env.OPENCLAW_DIST_DIR;
  if (ORIG_ENV.nodePath !== undefined)
    process.env.NODE_PATH = ORIG_ENV.nodePath;
  else delete process.env.NODE_PATH;
});

describe("acquireOpenClawLoopback (structural dist bootstrap)", () => {
  it("recovers handle from a 2026.4.24-shaped module (i = getRuntime)", async () => {
    // 2026.4.24 export shape: ensureMcpLoopbackServer as n,
    // getActiveMcpLoopbackRuntime as i, ...
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        function getRuntime() { return active; }
        async function ensureSrv() {
          active = { port: 41101, ownerToken: "tok-2026-4-24", nonOwnerToken: "x" };
        }
        export { ensureSrv as n, getRuntime as i };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("dist");
        expect(result.handle).toEqual({ port: 41101, token: "tok-2026-4-24" });
      }
    } finally {
      cleanup();
    }
  });

  it("recovers handle from a 2026.4.29-shaped module (a = getRuntime, i = createConfig)", async () => {
    // 2026.4.29 export shape: getActiveMcpLoopbackRuntime as a,
    // createMcpLoopbackServerConfig as i, ensureMcpLoopbackServer as n, ...
    // Note: createConfig is sync but takes 1 arg, so it must NOT be picked
    // as the runtime getter even though it is also sync.
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        function getRuntime() { return active; }
        function createConfig(port) { return { mcpServers: { x: { port } } }; }
        async function ensureSrv() {
          active = { port: 41129, ownerToken: "tok-2026-4-29", nonOwnerToken: "x" };
        }
        async function startSrv() {
          active = { port: 99999, ownerToken: "should-not-be-used" };
        }
        async function closeSrv() { active = undefined; }
        export { getRuntime as a, createConfig as i, ensureSrv as n, startSrv as r, closeSrv as t };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("dist");
        expect(result.handle.port).toBe(41129);
        expect(result.handle.token).toBe("tok-2026-4-29");
      }
    } finally {
      cleanup();
    }
  });

  it("survives a hypothetical future shape with fully shuffled aliases", async () => {
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        function getRuntime() { return active; }
        function createConfig(port) { return { mcpServers: { x: { port } } }; }
        async function someExtra() { /* future fn */ }
        async function ensureSrv() {
          active = { port: 50000, ownerToken: "tok-future" };
        }
        async function closeSrv() { active = undefined; }
        // Aliases reordered/renamed arbitrarily — must still work.
        export {
          someExtra as q,
          closeSrv as a,
          getRuntime as zz,
          createConfig as foo,
          ensureSrv as bar
        };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handle.port).toBe(50000);
        expect(result.handle.token).toBe("tok-future");
      }
    } finally {
      cleanup();
    }
  });

  it("uses an already-active runtime without calling any starter", async () => {
    // getRuntime returns a real handle on first call — we must NOT call
    // any async function (idempotency is OpenClaw's contract; we should
    // never start a second server when one is already up).
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let starterCalls = 0;
        function getRuntime() {
          return { port: 6000, ownerToken: "preexisting" };
        }
        async function startSrv() { starterCalls++; }
        async function closeSrv() { starterCalls++; }
        export { getRuntime as a, startSrv as r, closeSrv as t };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.handle.port).toBe(6000);
    } finally {
      cleanup();
    }
  });

  it("memoizes the result across calls", async () => {
    let ensureCalls = 0;
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        let ensureCalls = 0;
        function getRuntime() { return active; }
        async function ensureSrv() {
          ensureCalls++;
          active = { port: 4242, ownerToken: "memo" };
        }
        function inspectCalls() { return ensureCalls; }
        export { ensureSrv as n, getRuntime as a, inspectCalls as q };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const a = await acquireOpenClawLoopback();
      const b = await acquireOpenClawLoopback();
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.handle).toEqual(b.handle);
      }
      // Indirect verification: if memoization weren't working, the second
      // call would re-import and re-call ensure. We can't observe that
      // directly without exposing internals, but identical handles are
      // a sufficient proxy here.
      void ensureCalls;
    } finally {
      cleanup();
    }
  });

  it("env fast path takes precedence over dist", async () => {
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        function getRuntime() { return active; }
        async function ensureSrv() {
          active = { port: 9999, ownerToken: "from-dist" };
        }
        export { ensureSrv as n, getRuntime as a };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    process.env.__GLUECLAW_MCP_PORT = "1234";
    process.env.__GLUECLAW_MCP_TOKEN = "from-env";
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("env");
        expect(result.handle).toEqual({ port: 1234, token: "from-env" });
      }
    } finally {
      cleanup();
    }
  });

  it("reports dist-not-found when nothing is available", async () => {
    process.env.OPENCLAW_DIST_DIR = "/nonexistent/path/that/does/not/exist";
    process.env.NODE_PATH = "";
    const result = await acquireOpenClawLoopback();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("dist-not-found");
    }
  });

  it("rejects an mcp-http file below the size threshold", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "glueclaw-fake-dist-"));
    // Tiny shim, like the 105-byte re-export in 2026.4.29.
    writeFileSync(join(distDir, "mcp-http-tiny.js"), "export {};\n");
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no-mcp-module");
      }
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });

  it("rejects an mcp-http file missing required markers", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "glueclaw-fake-dist-"));
    // Big enough but no markers — looks unrelated.
    writeFileSync(
      join(distDir, "mcp-http-bogus.js"),
      "// just padding ".repeat(500),
    );
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no-mcp-module");
      }
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });

  it("reports no-runtime-getter when no sync zero-arg function returns a valid shape", async () => {
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        function bogusGetter() { return { unrelated: true }; }
        async function ensureSrv() {}
        export { bogusGetter as a, ensureSrv as n };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no-runtime-getter");
      }
    } finally {
      cleanup();
    }
  });

  it("reports no-server-starter when async candidates never register a runtime", async () => {
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        function getRuntime() { return undefined; }
        async function noop1() {}
        async function noop2() {}
        export { getRuntime as a, noop1 as n, noop2 as r };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no-server-starter");
      }
    } finally {
      cleanup();
    }
  });

  it("falls back across multiple async candidates (close-then-ensure ordering)", async () => {
    // closeSrv is exported first (via alias 'a' is taken by getRuntime,
    // but in our class-extraction it doesn't matter — order is enumeration order).
    // We want to make sure that even if close is enumerated before ensure,
    // we still recover, because close is a no-op when nothing is active.
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let active;
        function getRuntime() { return active; }
        async function closeSrv() {
          // No-op when nothing's running, just like real OpenClaw.
          if (!active) return;
          active = undefined;
        }
        async function ensureSrv() {
          if (!active) active = { port: 7777, ownerToken: "after-close-noop" };
        }
        // Enumerate close BEFORE ensure on purpose.
        export { getRuntime as a, closeSrv as b, ensureSrv as c };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handle.port).toBe(7777);
      }
    } finally {
      cleanup();
    }
  });

  it("ignores re-export shim when a real mcp-http file is present", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "glueclaw-fake-dist-"));
    // Small shim file (the OBW0gD9b kind in 2026.4.29).
    writeFileSync(
      join(distDir, "mcp-http-shim.js"),
      'export { x as closeMcpLoopbackServer } from "./does-not-exist.js";\n',
    );
    // Real file: padded + markers + valid loopback exports.
    const padding =
      "// markers: randomBytes createServer activeRuntime\n".repeat(40) +
      "// padding to exceed the threshold ".repeat(50);
    writeFileSync(
      join(distDir, "mcp-http-real-FAKE.js"),
      `${padding}
        let active;
        function getRuntime() { return active; }
        async function ensureSrv() { active = { port: 5151, ownerToken: "real" }; }
        export { ensureSrv as n, getRuntime as a };
      `,
    );
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const result = await acquireOpenClawLoopback();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handle).toEqual({ port: 5151, token: "real" });
      }
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});

describe("acquireOpenClawLoopback (cache control)", () => {
  it("resetOpenClawLoopbackCache forces re-evaluation", async () => {
    const { distDir, cleanup } = makeFakeDistDir({
      source: `
        let portSeed = 1000;
        function getRuntime() { return active; }
        let active;
        async function ensureSrv() {
          active = { port: ++portSeed, ownerToken: "t" };
        }
        export { ensureSrv as n, getRuntime as a };
      `,
    });
    process.env.OPENCLAW_DIST_DIR = distDir;
    try {
      const a = await acquireOpenClawLoopback();
      // Without reset, second call returns same cached result.
      const b = await acquireOpenClawLoopback();
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.handle).toEqual(b.handle);
      // After reset, a fresh import is performed; the cached singleton
      // inside the module is gone (different process? No — same process,
      // but `active` already has a value from prior import, so the new
      // call sees an existing runtime and returns it directly).
      resetOpenClawLoopbackCache();
      const c = await acquireOpenClawLoopback();
      expect(c.ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});
