# SRS-001: Bootstrap del MCP Loopback en GlueClaw

**Autor:** Roy  
**Fecha:** 2026-05-01  
**Estado:** Pendiente de decisión de implementación

---

## 1. Problemática

GlueClaw registra en OpenClaw como **provider** (no como CLI backend). El ciclo de vida
de preparación de sesiones de OpenClaw (`prepare.runtime-*.js`) solo arranca el servidor
MCP loopback cuando el backend tiene `bundleMcp: true` — propiedad exclusiva de CLI
backends como Codex o Google CLI.

Consecuencia: cuando GlueClaw lanza un subprocess de Claude CLI, el servidor MCP
loopback no está en marcha, `__GLUECLAW_MCP_PORT` no está seteado, y Claude no recibe
`--mcp-config`. Los tools de sesión (`sessions_send`, `sessions_list`, `sessions_spawn`,
etc.) aparecen listados en el system prompt pero no son invocables como function calls
reales — el subprocess no tiene acceso al servidor que los expone.

---

## 2. Objetivo

Que el subprocess de Claude CLI tenga disponibles los tools de sesión del gateway
(`sessions_send`, `sessions_list`, `sessions_spawn`, `cron`, etc.) como llamadas MCP
nativas, igual que ocurre en sesiones de CLI backends con `bundleMcp: true`.

Para ello es necesario que, antes de lanzar el subprocess:

1. El servidor MCP loopback del gateway esté arrancado (o ya lo estuviera).
2. GlueClaw conozca su puerto y token.
3. GlueClaw genere un fichero `mcp.json` temporal y pase `--mcp-config <path>` al
   subprocess de Claude.

---

## 3. Por qué el código actual no es válido

El bloque actual en `getMcpLoopback()` localiza el servidor haciendo:

```typescript
const nodePaths = (process.env.NODE_PATH ?? "").split(":");
const distDirs = nodePaths
  .filter(p => p.includes("openclaw"))
  .map(p => p.replace(/\/node_modules\/?$/, "/dist"));

for (const distDir of distDirs) {
  const files = await readdir(distDir);
  const mcpFile = files.find(f => f.startsWith("mcp-http-") && f.endsWith(".js"));
  const mod = await import(`file://${distDir}/${mcpFile}`);
  const ensureFn  = mod["n"] ?? mod["ensureMcpLoopbackServer"];
  const getRuntime = mod["i"] ?? mod["getActiveMcpLoopbackRuntime"];
  await ensureFn();
  const runtime = getRuntime();
  ...
}
```

**Problema 1 — Dependencia de aliases de bundle minificado.**
Los aliases `n`, `i`, `r`... son artefactos internos del proceso de build de OpenClaw.
No son API pública, no están documentados, y cambian con cualquier actualización:

| Versión OpenClaw | `getActiveMcpLoopbackRuntime` exportada como |
| ---------------- | -------------------------------------------- |
| 2026.4.24        | `i`                                          |
| 2026.4.29        | `a`                                          |

Con OpenClaw 2026.4.29, `mod["i"]` existe pero es `createMcpLoopbackServerConfig`,
no `getActiveMcpLoopbackRuntime`. El operador `??` no llega al fallback por nombre
porque la función no es `null`. GlueClaw llama a la función equivocada, `runtime.port`
es `undefined`, y el loopback queda `UNAVAILABLE`.

**Problema 2 — Acoplamiento a la estructura interna de distribución.**
La lógica depende de `NODE_PATH`, de que los dist dirs sigan el patrón
`/openclaw-<ver>/node_modules → /openclaw-<ver>/dist`, y de que el fichero se llame
`mcp-http-*.js`. Cualquier refactor de OpenClaw rompe silenciosamente el mecanismo.

**Problema 3 — El fallback por nombre no es suficiente como garantía.**
Usar `mod["getActiveMcpLoopbackRuntime"]` (nombre largo) funciona mientras el build
de OpenClaw mantenga los nombres sin ofuscar — lo cual tampoco está garantizado.

**Problema 4 — El error se traga silenciosamente.**
El bloque `catch { continue }` hace que cualquier fallo —nombre de fichero cambiado,
export renombrado, runtime sin port— resulte en `UNAVAILABLE` sin diagnóstico útil,
como se ha comprobado en producción.

---

## 4. Soluciones propuestas

### Opción A — API pública en OpenClaw (solución correcta a largo plazo)

OpenClaw expone una interfaz estable para que los providers arranquen el loopback:
un export named en `openclaw/plugin-sdk` o similar, o un campo en el contexto que
el gateway pasa al provider en `createStreamFn(ctx)`.

- **Pros:** desacoplamiento total, sin dependencia de internals.
- **Contras:** requiere cambio en OpenClaw. Puede tomar tiempo o no estar en el roadmap.

### Opción B — OpenClaw propaga `sessionKey` + puerto en `ctx` (ya pendiente)

Relacionado con openclaw/openclaw#73488. Si OpenClaw pasa `ctx.sessionKey` y también
`ctx.mcpPort` / `ctx.mcpToken` al provider, GlueClaw no necesita localizar ni arrancar
nada — simplemente lee lo que el gateway ya le da.

- **Pros:** la arquitectura más limpia; GlueClaw es un cliente pasivo.
- **Contras:** depende de que OpenClaw implemente y libere el cambio.

### Opción C — Patch al fichero dist de OpenClaw vía `install.sh` (en uso parcialmente)

`install.sh` ya parchea `mcp-http-*.js` para que setee `__GLUECLAW_MCP_PORT` y
`__GLUECLAW_MCP_TOKEN` en `process.env` cuando el loopback hace `bind`. Si OpenClaw
arranca el loopback en algún momento de la sesión (por cualquier razón), GlueClaw lo
ve en el entorno.

El problema actual es que el loopback **nunca arranca** para sesiones GlueClaw, así que
el patch no tiene efecto.

Extensión posible: que el patch también llame a `ensureMcpLoopbackServer()` en el
momento en que el gateway carga el módulo — antes de cualquier sesión. Esto aseguraría
que el loopback esté listo independientemente de qué backend se use.

- **Pros:** no requiere cambios en OpenClaw ni en `stream.ts`. Recae sobre `install.sh`.
- **Contras:** frágil — si el fichero se renombra o refactoriza, el patch falla. El
  `install.sh` ya tiene que buscar el fichero por patrón glob.

### Opción D — Usar el export por nombre largo y verificar identidad de función (mejora mínima sobre el estado actual)

Eliminar todos los aliases de una letra y usar únicamente los nombres largos:

```typescript
const ensureFn = mod["ensureMcpLoopbackServer"] as
  | (() => Promise<unknown>)
  | undefined;
const getRuntime = mod["getActiveMcpLoopbackRuntime"] as
  | (() => McpLoopbackRuntime | undefined)
  | undefined;
```

Añadir verificación de que `getRuntime` devuelve algo con la forma esperada
(`{ port: number, ownerToken: string }`) antes de usarlo.

- **Pros:** soluciona el problema inmediato de la colisión de aliases. Simple.
- **Contras:** sigue siendo dependencia de internals. Si OpenClaw ofusca los nombres
  en el futuro, vuelve a romperse. Parcheado, no resuelto.

---

## 5. Recomendación

**Corto plazo:** Opción D — eliminar los aliases y usar nombres largos. Soluciona el
`UNAVAILABLE` inmediato con riesgo mínimo.

**Medio/largo plazo:** Opción B — presionar para que OpenClaw propague `mcpPort`/`mcpToken`
en el contexto del provider, eliminando la necesidad de que GlueClaw gestione el
lifecycle del loopback.

La Opción A y la Opción C son viables pero implican más superficie de mantenimiento.
