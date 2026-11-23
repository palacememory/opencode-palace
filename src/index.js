// opencode-palace: local, verbatim memory for OpenCode, backed by Palace
// (https://github.com/AncientiCe/palace-rs).
//
// One default export serves both plugin APIs:
//   - OpenCode V2 reads `id` and `setup(ctx)`.
//   - OpenCode V1 (1.18.29 and newer) calls `server(input)`.
//
// The plugin adds automatic recall (session start, each prompt, and after the
// agent reads or greps) and a one-time save nudge when a session goes idle.
// The Palace MCP tools themselves come from the `palace` MCP server entry in
// opencode.json, which `palace install --client opencode` writes for you.
//
// Not associated in any way with the popular mempalace python.
import { INVESTIGATION_TOOLS, createQueue, palaceHook, resolvePalaceBin } from "./palace.js"

const ID = "palace"

// ---------------------------------------------------------------- V2 ------
async function setup(ctx) {
  const options = ctx.options ?? {}
  const bin = resolvePalaceBin(options)
  const cwd = ctx.location?.directory ?? process.cwd()
  const queue = createQueue()
  const started = new Set()
  const nudged = new Set()

  const ensureStarted = async (sessionID) => {
    if (!sessionID || started.has(sessionID)) return
    started.add(sessionID)
    const res = await palaceHook(bin, "session-start", { cwd, session_id: sessionID })
    queue.add(sessionID, res.additional_context)
  }

  await ctx.session.hook("prompt", async (event) => {
    await ensureStarted(event.sessionID)
    const res = await palaceHook(bin, "user-prompt-submit", {
      cwd,
      session_id: event.sessionID,
      prompt: event.prompt?.text ?? "",
    })
    queue.add(event.sessionID, res.additional_context)
  })

  // Runs right before every agent-loop model request, including tool continuations.
  await ctx.session.hook("context", async (event) => {
    await ensureStarted(event.sessionID)
    const text = queue.take(event.sessionID)
    if (text) event.system.push({ type: "text", text })
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" || !INVESTIGATION_TOOLS.has(event.tool)) return
    const res = await palaceHook(bin, "post-tool-use", {
      cwd,
      session_id: event.sessionID,
      tool_name: event.tool,
      tool_input: event.input ?? {},
    })
    // Delivered on the continuation request through the context hook.
    queue.add(event.sessionID, res.additional_context)
  })

  if (options.saveNudge !== false) {
    await ctx.session.hook("experimental.idle", async (event) => {
      const id = event.sessionID
      if (!id || nudged.has(id) || (event.background?.length ?? 0) > 0) return
      const res = await palaceHook(bin, "stop", { cwd, session_id: id })
      if (res.followup_message) {
        nudged.add(id)
        await ctx.session.prompt({ sessionID: id, text: res.followup_message }).catch(() => {})
      }
    })
  }
}

// ---------------------------------------------------------------- V1 ------
async function server(input = {}, options = {}) {
  const { client, directory } = input
  const bin = resolvePalaceBin(options)
  const queue = createQueue()
  const nudged = new Set()

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const id = event.properties?.info?.id
        const res = await palaceHook(bin, "session-start", { cwd: directory, session_id: id })
        queue.add(id, res.additional_context)
      } else if (event.type === "session.idle" && options.saveNudge !== false) {
        const id = event.properties?.sessionID
        if (!id || nudged.has(id)) return
        const res = await palaceHook(bin, "stop", { cwd: directory, session_id: id })
        if (res.followup_message) {
          nudged.add(id)
          client?.session
            ?.prompt({ path: { id }, body: { parts: [{ type: "text", text: res.followup_message }] } })
            .catch(() => {})
        }
      }
    },

    "chat.message": async (input, output) => {
      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const res = await palaceHook(bin, "user-prompt-submit", {
        cwd: directory,
        session_id: input.sessionID,
        prompt,
      })
      queue.add(input.sessionID, res.additional_context)
    },

    "experimental.chat.system.transform": async (input, output) => {
      const text = queue.take(input.sessionID)
      if (text) output.system.push(text)
    },

    "tool.execute.after": async (input, output) => {
      if (!INVESTIGATION_TOOLS.has(input.tool) || typeof output?.output !== "string") return
      const res = await palaceHook(bin, "post-tool-use", {
        cwd: directory,
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_input: input.args ?? {},
      })
      if (res.additional_context) output.output += `\n\n${res.additional_context}`
    },
  }
}

export default { id: ID, setup, server }
