# Security model

GameTable is a local desktop app. There is no GameTable account, server, or
telemetry endpoint. The network destinations are the OpenRouter API, using the
key you supply, and any local OpenAI-compatible endpoint you configure. This
document describes what is protected, what is not, and where the boundaries are
in the code.

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

- OpenRouter requests go to `https://openrouter.ai` (TLS, certificate verification on).
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

- `--share=network` for OpenRouter and configured local model servers.
- `--socket=wayland`, `--socket=fallback-x11`, `--socket=pulseaudio`,
  `--device=dri` for the window, audio, and rendering.
- `--share=ipc` for X11 fallback's shared-memory rendering, as required by the
  Flatpak/Flathub X11 configuration checks.
- `--talk-name=org.freedesktop.secrets` for encrypted key storage.
- **No** `--filesystem=home`, no host filesystem access. Importing and exporting
  replay transcripts goes through the XDG desktop portal file chooser, so the
  user explicitly picks the path.

Match data, results, and settings live under the app's private XDG directory
(`~/.var/app/io.github.fpetersen5_cpu.GameTable/config/GameTable`). Directories are
created `0700`, files `0600`, and every write goes through
`secureWrite()` (`apps/desktop/main/secure-file.ts`), which writes a temp file
and renames it, so a crash cannot leave a half-written secret or replay.

Changing the Flatpak ID does not grant access to the old app's sandbox data.
The optional host-side migration in `docs/FLATPAK-ID-MIGRATION.md` never copies
API keys or active sessions; users reenter their key in the new app.

## Hidden information

The anti-cheat boundary is the engine's `view()` projection
(`packages/engine/src/types.ts`). During play, a model's prompt is built only
from the view for its seat. Live human-player snapshots omit god views, and
Mafia views hide private night actors, kill votes and investigation targets.
Game-specific counterfactual tests vary hidden information while comparing
the complete view and model request. Synthetic secret labels are only a
supplementary exact-token check; alone, they cannot detect raw-state leaks.

Replays store the complete event log and god views as local `0600` files.
Post-game replay and spectator modes deliberately expose full information.
The post-game model debrief also sends an omniscient match record to the
selected OpenRouter model; it is not a seat-playing prompt.

### Transcript exports

- **Public is the default**, including for a spectator match. It includes only
  public chat and record lines visible in every seat projection. It does not
  export raw actions, seeds, hidden-role summaries, debriefs or god-view data.
- **Seat exports** are rebuilt through `view(state, seatId)` at every step.
  They contain that seat's permitted private chat and knowledge, not raw events
  or another seat's hidden state. They are private files, not safe public shares.
- **Omniscient export** is a separate explicit choice containing private chat,
  hidden roles and raw actions. Both private modes require a native warning
  confirmation (defaulting to Cancel), even for direct IPC requests. Files
  carry their perspective and sharing warning in the text and filename.
- If a replay cannot be rebuilt faithfully, public/seat export fails closed.
  It never silently falls back to the stored omniscient record. Older replays
  affected by projection fixes may require explicit omniscient export instead.
- Public export does not censor voluntary disclosures in public speech or
  role-revealing public game events. Review any transcript before sharing.

## Threat model

Protected against:

- **A compromised renderer / XSS in chat content.** It can only call the IPC
  surface; it never sees the key and its payloads are validated. Live player
  snapshots do not include god views. Post-game replay and spectator APIs
  intentionally expose game records; they are not secret vaults against a
  compromised renderer. Private transcript export requires native consent.
- **Model prompt injection trying to exfiltrate state during play.** Seat models
  receive only their own `view()`; they cannot read the key, the filesystem,
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
- **Metadata visible to OpenRouter or a local endpoint.** Model choice, prompt
  contents, token counts and timing go to the provider by design. A local
  endpoint is chosen by you and may be on another machine on your network.
- **Local endpoint URL validation is not a network firewall.** The main process
  accepts only http(s) URLs without credentials, queries or fragments, but a
  user-supplied endpoint can reach LAN hosts. Use endpoints you trust.
- **Backup contents.** Backups exclude the API key, live sessions and browser
  state, but contain settings, results and full replays (including hidden roles
  and private chat). They are written owner-only; review before sharing.
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

The native speech stack is not covered by npm's audit. Piper, eSpeak NG and
CPU-only ONNX Runtime are built offline from pinned sources; optional GPU,
training and telemetry components are disabled. Their source versions, licenses
and actual-model smoke checks are documented in `docs/RELEASE-CHECKLIST.md`.
Each synthesis process has a 60-second limit and bounded diagnostic output.

## Reporting

Open an issue at the project repository. Do not paste API keys into an issue;
revoke a key at <https://openrouter.ai/keys> if you believe it leaked.
