# Repository Guidelines

## Project Structure & Module Organization
- `packages/` — shared libraries: `crypto/`, `protocol/`, `utils/` (TypeScript, built to `dist/`).
- `server/` — relay HTTP/WebSocket server (CLI `entangle-server`).
- `agent/` — local agent that executes commands (CLI `entangle-agent`).
- `invoke/` — lightweight CLI client (CLI `entangle-invoke`).
- `web/` — React UI (Vite) for interacting with the relay.
- `tests/` — unit/integration helpers and suites; e2e stubs.
- `dist/` — build outputs (generated; do not edit).

## Build, Test, and Development Commands
- Build all: `npm run build` (runs workspace builds + bundles distribution).
- Dev server: `npm run dev` (alias for `--workspace=@sunpix/entangle-server`).
- Dev web: `npm run dev --workspace=@sunpix/entangle-web` (Vite on localhost).
- Dev agent: `npm run dev --workspace=@sunpix/entangle-agent`.
- Tests: `npm test` | watch: `npm run test:watch` | coverage: `npm run test:coverage`.
- Clean: `npm run clean` (all workspaces).

Requires Node 18+. Install once at root: `npm ci`.

## Coding Style & Naming Conventions
- Language: TypeScript (ES2022, ESM `NodeNext`, strict mode).
- Indentation: 2 spaces; keep lines concise; avoid unused exports.
- Filenames: kebab-case (`frame.test.ts`, `logger.ts`).
- Symbols: `PascalCase` types/classes, `camelCase` vars/functions, UPPER_SNAKE_CASE consts.
- Exports: prefer named exports from `src/` and index re-exports.

## Testing Guidelines
- Framework: Vitest with Node environment and globals; setup in `tests/test-setup.ts`.
- Location: co-locate unit tests as `*.test.ts` next to sources or under `tests/`.
- Coverage: aim for meaningful coverage; run `npm run test:coverage` before PRs.
- Fast tests (<10s) by default; mark slow/integration clearly.

## Commit & Pull Request Guidelines
- Commits: concise and scoped, e.g. `server: enforce rate limiting` or `utils: tighten validation`.
- PRs: include description, rationale, linked issues, test plan, and screenshots for `web/` UI changes.
- Keep diffs focused; update docs and examples when behavior changes.

## Security & Configuration Tips
- Secrets: never commit `.env`. Example:
  ```
  PORT=8080
  PUBLIC_ORIGIN=http://localhost:8080
  RELAY_URL=ws://localhost:8080
  LOG_LEVEL=info
  ```
- See `packages/utils/src/config.ts` for supported env vars (timeouts, limits, sandbox, paths). Align local `.env` with server/agent needs.
