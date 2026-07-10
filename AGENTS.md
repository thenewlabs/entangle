# Repository Guidelines

## Project Structure & Modules
- `agent/`: Agent CLI and PTY runner.
- `server/`: Relay (Express + WebSocket).
- `invoke/`: CLI to use capability URLs.
- `packages/`: Shared libraries (`protocol`, `crypto`, `utils`).
- `web/`: Optional SPA terminal client.
- `tests/`: Vitest suites (unit, integration, security, e2e).
- `docs/`: Architecture and component docs.
- `dist/`: Built bundles (top-level script); workspace builds write to each package `dist/`.

## Build, Test, and Dev
- `npm install`: Install root deps and workspaces.
- `npm run build`: Build all workspaces, then bundle `dist/{serve,connect,relay}.js`.
- `npm run dev --workspace=@thenewlabs/entangle-relay`: Start relay in watch mode.
- `npm run dev --workspace=@thenewlabs/entangle-serve`: Start serve in watch mode.
- `npm test`: Run Vitest.
- `npm run test:coverage`: Generate V8 coverage (text, JSON, HTML).
- Example binaries after build: `entangle-relay`, `entangle-serve`, `entangle-connect`.

## Coding Style & Naming
- Language: TypeScript (Node 18+, `module`/`resolution: NodeNext`, strict on).
- Indentation: 2 spaces; semicolons on; single quotes preferred.
- Exports: prefer named exports; avoid default unless ergonomic.
- Files/dirs: kebab-case (`runner-utils.ts`, `rate-limit.ts`). Classes: PascalCase; functions/vars: camelCase.
- No ESLint/Prettier configured; keep code minimal, typed, and consistent with existing patterns.

## Testing Guidelines
- Framework: Vitest with globals; config in `vitest.config.ts`.
- Locations: top-level `tests/` plus package-local tests when helpful.
- Naming: `*.test.ts` (e.g., `multi-stream-protocol.test.ts`).
- Run focused tests: `npx vitest --run tests/e2e/` or `npx vitest path/to/file.test.ts`.
- Aim for coverage of protocol parsing, crypto edges, validation, and relay behavior.

## Commit & PR Guidelines
- Style: short imperative subject (≤72 chars). Use scopes when clear: `server:`, `agent:`, `docs:`, `tests:`. Conventional Commits welcome (`feat:`, `fix:`, `refactor:`).
- PRs: include purpose, linked issues, test plan/output, and any `docs/` updates. For `web/` changes, add screenshots.
- Security-impacting changes must call out risks, mitigations, and configuration notes.

## Security & Configuration Tips
- Keep the relay blind: never log plaintext payloads or secrets.
- Respect limits and validation; avoid expanding defaults without justification.
- Key env vars: see README and `packages/utils/src/config.ts` (e.g., `AGENT_DEFAULT_CWD`, `MAX_FRAME_BYTES`).
