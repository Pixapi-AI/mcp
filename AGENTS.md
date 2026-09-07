# pixapi-mcp Development Guide

## Scope

This repository contains the public `pixapi-mcp` CLI: a local stdio bridge that
lets stdio-only MCP clients talk to the remote Pixapi MCP server.

- The remote MCP server, plus sign-in, install-session persistence, and API Key
  creation, live in separate private services. This package never touches the
  business database and never implements billing on its own.
- By default, users connect straight to the remote MCP endpoint over OAuth and
  do not need Node.js installed.
- The published npm package is the compatibility entry point for stdio-only
  clients: a dashboard API Key plus the `init` and `proxy` commands.
- A signed native bridge that removes the Node.js requirement, and a browser
  device-flow install endpoint, are planned enhancements.

## Common commands

- `pnpm test`: run the unit and integration tests.
- `pnpm test:coverage`: run the tests and enforce the 80% global coverage floor.
- `pnpm typecheck`: run strict TypeScript checking.
- `pnpm build`: compile to `dist/`.
- `PIXAPI_API_KEY=... pnpm dev -- init ...`: run the install command from source.
- `pnpm release:check`: type check, coverage, and build before publishing.

## Development rules

1. Follow TDD: every behavior change starts with a new or updated failing test
   before the implementation.
2. Never log `device_code`, API Keys, Authorization headers, or the contents of
   credential files.
3. Never write an API Key into any client configuration (Claude Code, Cursor,
   Codex, VS Code, Gemini CLI). Project configuration may only start the local
   bridge.
4. Credential writes must be atomic and must keep `0700` on directories and
   `0600` on files.
5. Stay on the validated MCP TypeScript SDK v1 until the v2 migration is
   approved.
6. The v0.1 bridge forwards tools only. resources, prompts, sampling, and
   elicitation each need their own design and tests.
7. User-facing errors must suggest the next action and must never leak internal
   server responses or database details.
8. Implement behavior against MCP capabilities, never by branching on client
   names such as ChatGPT, Claude, or WorkBuddy.
9. Keep a single source of truth for each Skill. Platform directories may only
   contain the manifest, the install method, and required format adaptations.
10. The npm bridge and every platform-native bridge must pass the same shared
    protocol behavior test suite.
