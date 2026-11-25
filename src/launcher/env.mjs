const inheritedSession = /^(?:CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_|CODEX_(?:THREAD_ID$|TURN_ID$|CALL_ID$|APP_TOOLS_)|ANTIGRAVITY_|AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP$|AGENT_BRIDGE_|DSH_MCP_TOKEN$|DSH_BRIDGE_)/i

export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !inheritedSession.test(name)))
}
