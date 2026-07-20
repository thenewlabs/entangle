# Entangle

Your dev box is sitting at home with everything already set up on it: the repo, the database, the half-finished branch. Entangle gives you a URL that reaches it, and a relay in the middle that cannot read a single thing you send.

That last part is the whole idea. The relay forwards encrypted frames. It knows which capability a frame belongs to, how big it is and which IP it came from. It does not know the secret, it cannot derive the keys and it never sees plaintext. You can run the relay on a VPS you half-trust, or on someone else's, and the security story does not change.

```bash
# On the machine you want to reach
entangle serve https://your-relay.example.com

# prints a capability URL:
#   https://your-relay.example.com/cap/cap_7f3a91#S=k4Xn...

# From anywhere else
entangle connect 'https://your-relay.example.com/cap/cap_7f3a91#S=k4Xn...' pwd
```

Open that URL in a browser and you get a terminal. Point `entangle connect` at it and you get the same terminal, or a single command with its exit code. Close the agent and the URL is dead, because the secret was never written to disk.

## How the secret stays secret

Look closely at the URL:

```
https://your-relay.example.com/cap/cap_7f3a91#S=k4Xn...
                              └─── path ───┘ └ fragment ┘
```

Everything before the `#` reaches the relay. Everything after it does not. Browsers have never sent the fragment to a server, so `S` arrives at the tab you opened without ever passing through the relay that served the page. The browser then uses it to authenticate directly to your agent, through the relay, over a connection the relay is merely carrying.

So the capability URL is a live credential. Anyone holding it can type into your shell. Treat it like an SSH key that happens to be a link: send it over something private, and add `--password` when you want a second factor.

## Install

```bash
npm install -g @thenewlabs/entangle
```

That gives you one `entangle` command that dispatches to the three tools. You can also install them separately if you only need one:

```bash
npm install -g @thenewlabs/entangle-relay     # the blind relay
npm install -g @thenewlabs/entangle-serve     # the agent, runs on your machine
npm install -g @thenewlabs/entangle-connect   # the client CLI
```

Node 18 or newer.

## The three pieces

**`entangle serve`** runs on the machine you want to reach. It mints the capability, holds the PTYs, runs the commands and dials any pipes you registered. All the trust lives here.

**`entangle relay`** is the part you expose to the internet. Express plus WebSockets, routing opaque frames between agents and clients. It has no configuration flags at all, only environment variables, because there is nothing to configure about a thing that cannot read its own traffic.

**`entangle connect`** is the terminal client. One command, or an interactive session.

Each one documents its own flags and environment in `--help`. Start there rather than here:

```bash
entangle serve --help
entangle relay --help
entangle connect --help
```

## Running the whole thing locally

Start a relay:

```bash
entangle relay start          # listens on 0.0.0.0:8080
```

Point an agent at it. The directory you launch from becomes both the working directory and the execution boundary, so `cd` into the project you actually want to expose:

```bash
cd ~/projects/my-app
RELAY_URL=http://localhost:8080 entangle serve
```

It prints a capability URL. Use it:

```bash
entangle connect 'http://localhost:8080/cap/<capId>#S=<secret>' ls -la
entangle connect 'http://localhost:8080/cap/<capId>#S=<secret>'      # interactive
```

Quote the URL. Unquoted, your shell reads `#S=...` as a comment and throws the secret away before entangle sees it.

## Shared terminals, and sessions that outlive your terminal

When you run `entangle serve` from a real terminal, everyone who opens the URL lands in the **same live shell**. That is the default because pairing is the common case: you send a link, someone joins, you both watch the same output. Pass `--headless` if you would rather every connection get its own private shell.

Interactive shared sessions are daemonized the way tmux does it. A detached process owns the session and the relay connection, and your terminal is just a client attached to it. Close the window and the session keeps running:

```bash
entangle serve --detach       # start in the background, print the URL
entangle ls                   # what is running
entangle attach <name>        # come back to it
entangle kill <name>          # stop it
```

Behind that is a headless terminal emulator fed every byte the PTY produces. Live output still fans out byte for byte, but a reattach replays a serialized current screen instead of a raw byte log. That is why vim and tmux repaint correctly when you come back, rather than dumping their scrollback at you.

## Production relay

Put the relay behind something that terminates TLS. With Caddy:

```caddyfile
entangle.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then:

```bash
PUBLIC_ORIGIN=https://entangle.example.com \
TRUST_PROXY=1 \
RELAY_AGENT_TOKEN=$(openssl rand -hex 32) \
entangle-relay start
```

Three things matter here. `TRUST_PROXY=1` makes the relay read client IPs from `X-Forwarded-For`, which is correct behind a proxy you control and forgeable everywhere else, so leave it off otherwise. `RELAY_AGENT_TOKEN` stops strangers registering agents and squatting capabilities on your relay; agents must then present the same token. And `RELAY_REQUIRE_AGENT_TOKEN` turns itself on when `NODE_ENV=production`, so a production relay refuses registration entirely if you forgot to set a token.

Check it with `curl https://entangle.example.com/__health`.

## The trust model in detail

**Two key hierarchies, and they never mix.** The bootstrap keys come from `HKDF(K_raw, info='entangle-capability')` and are identical every session. They do exactly two jobs: the AUTH1 HMAC and AUTH2. They never encrypt data. The session keys come from `HKDF(K_raw, salt=nonceB‖nonceC, info='entangle-session-v2')` using fresh handshake nonces, and they encrypt everything else. Capture a session's ciphertext and you cannot replay it into another one, because the keys that produced it no longer exist.

**AEAD with direction-bound AAD.** Frames are sealed with XChaCha20-Poly1305. The associated data binds each frame to its type *and* its direction, so a frame cannot be reflected back at whoever sent it.

**The client checks the relay's work.** It verifies the echoed `nonceB` and the session `expiryTs`, so a hostile or replaying relay cannot impersonate the agent or feed you stale output.

**The optional password is a real second factor.** Stored with Argon2id, verified in constant time, and deliberately never read from the URL. Pass it with `--password` or `AGENT_PASSWORD`, so it does not travel next to `S`.

**One directory knob.** `AGENT_DEFAULT_CWD` is both the working directory and the execution boundary, and it defaults to wherever you launched the agent. Enforcement lives in exactly two agent-side places: `resolveCwd()` in `serve/src/stream-manager.ts`, calling `validateCwd()` in `packages/utils/src/validation.ts`, on the command path and the PTY path alike.

Be clear-eyed about what that last one buys you. It pins the *initial* working directory. It is not a filesystem sandbox: a command that runs can still `cd` elsewhere or open absolute paths. If you need a real boundary, run the agent in a container, a chroot or a namespace.

## Streams and pipes

The wire format is `[1 byte type][8 byte big-endian length][payload]`. Live traffic uses the `STREAM_*` family, `0x30` through `0x36`, plus `WINDOW_CTL` at `0x40`. The `0x10` and `0x20` families are the legacy single-stream and PTY frames. All of it is defined in `packages/protocol/src/types.ts`.

A `STREAM_OPEN` carries one of three modes. `cmd` runs a command, `pty` opens a terminal and `pipe` is the extension point.

A pipe is a named channel you register before anything connects, and the agent bridges it to a raw socket:

```bash
ENTANGLE_PIPES='api=tcp:127.0.0.1:7060,db=unix:/tmp/db.sock' entangle serve
```

No cwd resolution, no argv validation, no environment: just bytes moving between a stream and a socket. Registration fails closed, so one malformed spec disables the set rather than silently dropping an endpoint. Only the pipe *names* go into the advertised policy hash. The targets never leave the machine.

Note that `maxStreams` defaults to **1**. A client that wants several pipes at once has to raise it, which is done programmatically through `startAgent()` rather than by flag.

## Repo layout

| Path | Package | What it does |
|---|---|---|
| `serve/` | `@thenewlabs/entangle-serve` | The agent: capabilities, PTYs, exec, pipes, shared workspaces |
| `relay/` | `@thenewlabs/entangle-relay` | The blind relay, Express + WS |
| `connect/` | `@thenewlabs/entangle-connect` | Client CLI, one-shot or interactive |
| `cli/` | `@thenewlabs/entangle` | Dispatcher that spawns the above, forwarding argv verbatim |
| `web/` | `@thenewlabs/entangle-web` | The browser terminal, and the `window.entangle` client the relay injects |
| `packages/protocol` | `@thenewlabs/entangle-protocol` | Frame codec, schemas, frame types |
| `packages/crypto` | `@thenewlabs/entangle-crypto` | Argon2id, HKDF, XChaCha20-Poly1305 |
| `packages/utils` | `@thenewlabs/entangle-utils` | Config, validation, counters |

## Development

```bash
npm install
npm run build                # tsc across workspaces, then bundle dist/
npm test                     # vitest
npm run test:coverage

npm run dev --workspace=@thenewlabs/entangle-relay    # watch mode
npm run dev --workspace=@thenewlabs/entangle-serve
```

Focus a run with `npx vitest run tests/security/` or a single file path.

Further reading lives in `docs/`: [`e2e.md`](docs/e2e.md) for the handshake and protocol, [`shared.md`](docs/shared.md) for shared terminals, [`connect.md`](docs/connect.md) for the client CLI.

## Compatibility

This is protocol **v2** and it is not wire-compatible with 1.0.0. Upgrade serve, relay and connect together. Existing `#S=` capability URLs stay valid; password-protected capabilities need their password set again.
