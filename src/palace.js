// Talks to the local `palace` binary. Every call fails open: if Palace is
// missing or errors, the caller gets `{}` and OpenCode runs as if the plugin
// were not installed.
import { spawn } from "node:child_process"

export function resolvePalaceBin(options = {}) {
  return options.palaceBin || process.env.PALACE_BIN || "palace"
}

// Run `palace hook <event> --client opencode` with `payload` on stdin and
// resolve to its JSON response, or `{}` on any failure or timeout.
export function palaceHook(bin, event, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ""
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(bin, ["hook", event, "--client", "opencode"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch {
      finish({})
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({})
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", () => finish({}))
    child.on("close", () => {
      try {
        finish(JSON.parse(out.trim() || "{}"))
      } catch {
        finish({})
      }
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

// Per-session buffer of context waiting for the next model request.
export function createQueue() {
  const pending = new Map()
  return {
    add(sessionID, text) {
      if (!sessionID || !text) return
      const prior = pending.get(sessionID)
      pending.set(sessionID, prior ? `${prior}\n\n${text}` : text)
    },
    take(sessionID) {
      const text = sessionID && pending.get(sessionID)
      if (text) pending.delete(sessionID)
      return text || undefined
    },
  }
}

export const INVESTIGATION_TOOLS = new Set(["read", "grep", "glob", "bash"])
