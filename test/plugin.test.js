// Exercises both plugin APIs against a real `palace` binary with fake
// OpenCode hosts. Set PALACE_BIN, and point HOME/PALACE_PALACE_PATH at a test
// palace that has something mined, e.g. `palace mine ./fixture`.
import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../src/index.js"

const cwd = process.env.PALACE_TEST_CWD || process.cwd()
const question = process.env.PALACE_TEST_PROMPT || "why is the job queue on SQLite?"

test("default export has V1 and V2 entrypoints", () => {
  assert.equal(plugin.id, "palace")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("V2: prompt recall is injected into the next model request", async () => {
  const hooks = {}
  const ctx = {
    options: {},
    location: { directory: cwd },
    session: {
      hook: async (name, cb) => ((hooks[`session.${name}`] = cb), { dispose() {} }),
      prompt: async () => ({}),
    },
    tool: { hook: async (name, cb) => ((hooks[`tool.${name}`] = cb), { dispose() {} }) },
  }
  await plugin.setup(ctx)
  assert.ok(hooks["session.prompt"] && hooks["session.context"] && hooks["tool.execute.after"])

  await hooks["session.prompt"]({ sessionID: "s2", prompt: { text: question }, delivery: "steer" })
  const req = { sessionID: "s2", system: [], messages: [], options: {} }
  await hooks["session.context"](req)
  assert.ok(req.system.length >= 1, "expected Palace context in system parts")
  assert.match(req.system.map((p) => p.text).join("\n"), /Palace/)

  // Queue drained: a second request gets nothing new.
  const again = { sessionID: "s2", system: [], messages: [], options: {} }
  await hooks["session.context"](again)
  assert.equal(again.system.length, 0)
})

test("V1: system transform receives queued recall", async () => {
  const hooks = await plugin.server({ directory: cwd, client: {} })
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: question }] })
  const out = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, out)
  assert.equal(out.system.length, 1)
  assert.match(out.system[0], /Palace/)
})

test("fails open when the binary is missing", async () => {
  const hooks = await plugin.server({ directory: cwd, client: {} }, { palaceBin: "/nonexistent/palace" })
  await hooks["chat.message"]({ sessionID: "s3" }, { parts: [{ type: "text", text: "hi" }] })
  const out = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s3" }, out)
  assert.equal(out.system.length, 0)
})
