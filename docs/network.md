# Network

How main reaches models, and what it guarantees. `src/main/net/network.ts` is the one way out;
`src/main/net/electron-transports.ts` connects it to Electron.

| Connection                                        | Route                                 | Proxy                                                                   | Certificates                                          |
| ------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Anthropic API, OpenAI API, Gemini API, OpenRouter | `cloudFetch`: session `network-cloud` | The system's, including PAC and WPAD                                    | The system's store, through Chromium's verifier       |
| ChatGPT Plan: chat, model list                    | `cloudFetch`                          | The same                                                                | The same                                              |
| ChatGPT Plan: discovery, keys, token, revoke      | `cloudFetch`                          | The same                                                                | The same                                              |
| ChatGPT Plan: the sign-in page                    | The system browser                    | The browser's                                                           | The browser's                                         |
| Ollama, LM Studio                                 | `localFetch`: session `network-local` | Never: `mode: 'direct'`                                                 | None: plain http on loopback                          |
| Claude and Codex subscriptions                    | The bundled runtime, a subprocess     | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` from the environment, see below | The runtime's own: not the system's store (see below) |

## What every request gets

`createGuardedFetch` applies these whatever the caller passes:

- **The address is checked first.** `cloudFetch` allows https to `OFFICIAL_HOSTS` on the default
  port; `localFetch` allows http to `127.0.0.1`, `[::1]` and `localhost`. Anything else is refused
  before a transport sees it. The clients keep their own per-provider checks; this is the backstop,
  and what holds the Anthropic SDK (which reads `ANTHROPIC_BASE_URL`) to its address.
- **Redirects are refused**: `redirect: 'error'`. Electron rejects without following, so the
  request stops at the first host. Note that Electron's `redirect: 'manual'` also rejects: unlike
  Node's fetch it never resolves with a 3xx. The Anthropic SDK asks for `follow` by default, which
  would have sent `x-api-key` onward; that no longer reaches the network.
- **No session state**: `credentials: 'omit'`, `cache: 'no-store'`, and two in-memory sessions of
  their own, never the default session.
- **A body read stops the request.** Cancelling Electron's body stream stops the reading but leaves
  the request running, so the wrapper aborts it too. Size limits depend on this.
- **Failures are classified, never forwarded.** `NetworkFailure` holds a kind and a Chromium error
  name that matched a pattern, and no cause: a raw error can carry a URL.

## Before the app is ready

`Session.fetch` and `session.fromPartition` throw until the app is ready, so `index.ts` installs the
transports at the start of `whenReady`, before anything that sends a request. Until then a request
fails with `not-ready`. **There is no fallback to Node's fetch**, and a second install throws.

Unit tests run outside Electron. `src/main/net/vitest-setup.ts`, which only `vitest.config.ts`
loads, installs a transport over Node's fetch that behaves as Electron does for redirects.

## Why local servers have their own session

A proxy must never see loopback traffic. Neither of the easy answers guarantees that:

- Chromium skips the proxy for loopback only by default. A system bypass list containing
  `<-loopback>` turns that off, and loopback then goes to the proxy.
- Node's fetch does not use a proxy, unless `NODE_USE_ENV_PROXY=1` is set: then it sends a CONNECT
  for `127.0.0.1` to the proxy.

A session in `direct` mode has no proxy to consult. `e2e/network-proxy.spec.ts` checks all three.

## Proxy sign-in

No request has a `login` listener, so Electron cancels an authentication challenge rather than
showing a dialog, and the user gets the proxy message below. Chromium answers a proxy that uses
the Windows sign-in (NTLM, Negotiate) by itself, without a prompt, as a browser does. A proxy that
needs a typed password (Basic) is therefore not supported, and fails with a clear error. The
proxy's own 407 is never handed to a client as if the provider had sent it.

## Messages

`networkErrorMessage` writes these, ending in a safe Details line as other errors do:

- Proxy: `Could not reach Claude through your network's proxy or security software. Details: ERR_TUNNEL_CONNECTION_FAILED.`
- Certificate: `Could not reach Claude through your network's proxy or security software: the connection's certificate is not trusted. Details: ERR_CERT_AUTHORITY_INVALID.`
- Offline: `Could not reach Claude: this computer appears to be offline. Details: ERR_INTERNET_DISCONNECTED.`
- Anything else keeps the client's own message, with a Details line when Chromium named the error.

All of them use the code `network`, so retries and the rest of the run behave as before. A ChatGPT
Plan refresh that fails this way is transient: the sign-in is kept.

## Bundled runtimes

Claude and Codex are subprocesses with their own network stacks, started with `runtimeEnv`, a
deliberate allowlist that excludes endpoint overrides. It is separate from the shell tool's
allowlist, and neither changed.

`runtimeProxyEnv` adds `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` for the runtimes only
(`isolatedContext`), when the user's environment has them. `native.test.ts` runs both pinned
binaries against a local proxy.

- Only a plain `http(s)://host:port` passes. A URL with a password is dropped, since the value would
  reach whatever the runtime starts. So is one without a scheme.
- `NO_PROXY` always includes loopback.
- TLS still ends at the provider, so this hands the proxy no credentials.

What they do not get:

- **The Windows proxy setting.** It is not in the environment, so a machine configured only in
  Windows settings or by PAC does not pass one on. We could resolve it with `session.resolveProxy`,
  but that answers per URL and an authenticating proxy would still fail. Set `HTTPS_PROXY` for now.
- **The Windows certificate store.** A TLS-inspecting CA would need `NODE_EXTRA_CA_CERTS` (Claude) or
  `CODEX_CA_CERTIFICATE` (Codex), which the allowlist deliberately leaves out, because they widen
  what the runtime trusts. Not changed here.

## What needs a real corporate network

`e2e/network-proxy.spec.ts` runs through real Chromium sessions and a local proxy. On Windows CI it
sets the real Internet Settings key and puts a test root in the machine's store. It cannot cover:

- NTLM or Negotiate sign-in to a real proxy.
- PAC or WPAD from a real network (PAC is Chromium's own handling, resolved per request).
- A real TLS-inspection product, including how it presents its chain.
- Client certificates: a network that requires one fails with a certificate message.
