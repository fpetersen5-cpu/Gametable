# Security model

GameTable is a local desktop app. There is no GameTable account, server, or
telemetry endpoint. The only network destination is the OpenRouter API, using
the key you supply. This document describes what is protected, what is not, and
where the boundaries are in the code.

## Credentials

### Where the key lives

The API key is read, decrypted, and used **only in the Electron main process**.
It is never sent to the renderer, never written to a replay, a transcript, a
log line, or a crash message.

| Path | When | Protection |
| --- | --- | --- |
| `secrets.enc` | An OS keyring is available | Encrypted with Electron `safeStorage` (libsecret/KWallet); file is `0600` |
| `secrets.json` | No keyring available | Plaintext `0600` file inside the app's private config directory; the UI says so explicitly |
| old `secrets.json` | Upgrading from a pre-encryption build | Read once, re-encrypted into `secrets.enc`, then deleted |

`safeStorage` is used because it is the same battle-tested path Electron uses
for its own cookie encryption on Linux, and because it works inside the Flatpak
sandbox through `org.freedesktop.secrets` (granted in the manifest). If the
host has no running secret service, `safeStorage.isEncryptionAvailable()`
returns false and the app falls back instead of failing to start. The settings
screen shows which mode is active.

Electron picks the keyring backend from the desktop environment. If that guess
is wrong for your session (for example a KDE desktop whose only secret service
is gnome-keyring), set `GAMETABLE_PASSWORD_STORE` to `gnome-libsecret` or
`kwallet` to force it. On KDE desktops without any running secret service the
app falls back to the `0600` file, and the settings screen says "no keyring
available".

`apps/desktop/main/secrets.ts` owns this logic. It takes an injectable
`CryptoBackend`, so the fallback, migration, and keyring-loss paths are unit
tested without a desktop session.

### In transit

- All requests go to `https://openrouter.ai` (TLS, certificate verification on).
- The key travels only in the `Authorization: Bearer …` header. It is never
  placed in a URL, query string, or request body.
- Requests carry `HTTP-Referer` and `X-Title` for OpenRouter attribution and
  nothing else.
- Request timeouts are 90 seconds, retries are capped, and at most six
  completions are in flight at once.

### Redaction

Provider errors can echo request material. Everything that can reach the UI, a
log, or a stored record passes through `redact()`
(`packages/agent/src/redact.ts`), which strips `sk-or-…` keys, bearer tokens,
generic `sk-…` tokens, and `apiKey` fields. Provider error bodies are redacted
and trimmed to 300 characters before being attached to an exception.

## Renderer and IPC

- The renderer has `contextIsolation: true`, `sandbox: true`, `nodeIntegration:
  false`, and no remote module. Its only privileged surface is the
  `window.gametable` bridge defined in the preload script.
- Every IPC handler is wrapped by a sender check: a call is accepted only if it
  arrives from the app's own top-level `webContents`. Any other frame is
  rejected before the handler runs.
- Payloads are validated before use (`apps/desktop/main/validation.ts`): seat
  counts, seat kinds, model IDs, persona and name lengths, budgets, speed,
  seed, arena match counts, recording sizes, action sizes, takeover seat IDs,
  and match ID formats. Invalid requests are rejected with a message, not
  coerced into a match.
- The production content security policy is
  `default-src 'self'; script-src 'self'; connect-src 'self' ws://localhost:5173;
  object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  The renderer makes no network requests at all; all model traffic goes through
  IPC to the main process. (`ws://localhost:5173` only exists so the Vite dev
  server's HMR socket works; production never opens it.)

## Sandbox (Flatpak)

The manifest grants exactly what the app needs:

- `--share=network` for OpenRouter.
- `--socket=wayland`, `--socket=fallback-x11`, `--socket=pulseaudio`,
  `--device=dri` for the window, audio, and rendering.
- `--talk-name=org.freedesktop.secrets` for encrypted key storage.
- **No** `--filesystem=home`, no host filesystem access. Importing and exporting
  replay transcripts goes through the XDG desktop portal file chooser, so the
  user explicitly picks the path.

Match data, results, and settings live under the app's private XDG directory
(`~/.var/app/io.github.takmikill.GameTable/config/GameTable`). Directories are
created `0700`, files `0600`, and every write goes through
`secureWrite()` (`apps/desktop/main/secure-file.ts`), which writes a temp file
and renames it, so a crash cannot leave a half-written secret or replay.

## Hidden information

The anti-cheat boundary is the engine's `view()` projection
(`packages/engine/src/types.ts`). A model's prompt is built only from the view
for its seat; the full game state is never serialized into an LLM request.
Replays store the complete event log (including god views for the post-game
debrief), which is why replay files are local `0600` files and not exported
verbatim — transcript export contains the seat-perspective transcript you
choose to save.

## Threat model

Protected against:

- **A compromised renderer / XSS in chat content.** It can only call the typed
  IPC surface; it never sees the key or raw state, and its payloads are
  validated.
- **Model prompt injection trying to exfiltrate state.** Models only ever
  receive their own seat's `view()`; they cannot read the key, the filesystem,
  or other seats' roles. Model output is treated as game text, parsed with a
  bounded schema, and never executed.
- **Casual disk inspection.** The key is keyring-encrypted when possible; game
  files, which contain hidden roles, are owner-only.
- **Log leakage.** Error paths redact credential shapes before display.

Not protected against:

- **Root or your own user account.** A process running as you can read the
  app's config directory, and can ask the keyring for the key as you. Full-disk
  encryption and OS account hygiene are out of scope.
- **A locked or unavailable keyring.** If the secret service is missing at
  launch, the fallback is a `0600` file, not encryption. The UI states this.
- **Metadata visible to OpenRouter.** Model choice, prompt contents, token
  counts, and timing go to OpenRouter by design. This is the same exposure as
  using OpenRouter directly.
- **Replay/transcript contents.** They are game records and may contain
  private chat and hidden roles. They are not encrypted at rest, only
  permission-restricted.

## Dependency security checks

Run `npm run audit:deps` to audit the full npm dependency tree. CI runs this
after `npm ci` and fails on reported vulnerabilities. Do not use `--omit=dev`
as the release gate: Electron is a development dependency in npm but its
runtime is included in the shipped application.

Electron is pinned to an exact version in `apps/desktop/package.json`. When
upgrading it, update the Flatpak manifest's binary URL, upstream SHA-256 and
Electron cache directory together, then regenerate `flatpak/node-sources.json`
with `flatpak/generate-sources.py`. Test with `npm run check` and `npm run build`,
and rebuild the Flatpak; changing the lockfile alone does not patch an already
installed runtime.

## Reporting

Open an issue at the project repository. Do not paste API keys into an issue;
revoke a key at <https://openrouter.ai/keys> if you believe it leaked.
