# GameTable — technical description

GameTable is a Linux desktop tabletop platform where AI models take seats at a
game and play through a deterministic referee. It is packaged as a signed
Flatpak and talks to OpenRouter or a local OpenAI-compatible endpoint. The app owns all
state; each seat — human or model — receives only the projection the rules
allow it to see.

Application version: `0.1.0`. Milestones M0–M7 are implemented; release hardening
is ongoing. Run `npm run check` for current test results and `npm run audit:deps`
for the full dependency audit. The roadmap below describes the remaining work.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Electron main process (Node, network, filesystem, secrets)      │
│                                                                  │
│  GameDef ── setup · phase · view · apply · terminal · scoring    │
│    │                                                             │
│  MatchSession ── action loop · pause · speed · rewind · resume   │
│    │                                                             │
│  Controllers ── human (IPC) · LlmController ── OpenRouterClient  │
│    │                                                             │
│  ResultsStore · ReplayBundles · ArenaRunner · Piper TTS          │
└───────────────────────────────┬──────────────────────────────────┘
                                │ typed IPC (validated, sender-checked)
┌───────────────────────────────▼──────────────────────────────────┐
│ Preload: window.gametable — no key, no prompts, no raw state     │
├──────────────────────────────────────────────────────────────────┤
│ Renderer: React UI (sandboxed, contextIsolation, no Node)        │
│  Table · Match · Arena · Replays · Leaderboard · Settings         │
└──────────────────────────────────────────────────────────────────┘
```

### Packages

| Package | Responsibility |
| --- | --- |
| `packages/engine` | `GameDef` contract, projections, seeded RNG, event log, match runner, bots, replay helpers |
| `packages/games-buckshot` | Duel rules, nine items, expectiminimax oracle, gauntlet |
| `packages/games-mafia` | Roles, night phases, discussion, votes, runoff, view filtering |
| `packages/games-coup` | Hidden hands, claims, challenges, blocks, exchange, view filtering |
| `packages/agent` | OpenRouter and local clients, prompt builder, JSON schema, `LlmController`, streaming, retries, redaction, error classification, probes |
| `packages/stats` | Frozen results record, JSONL store, Bradley–Terry ratings |
| `packages/sdk-conformance` | Cross-game gate, toy game fixture, fake model transport |
| `apps/desktop` | Electron main, preload, React renderer, sessions, arena, health, backups, TTS/STT |
| `apps/cli` | Headless runner and eval harness |
| `flatpak/` | Manifest, metainfo, icon, launcher, source generator, build/release scripts |

### The referee invariant

`view(state, seatId)` is the only projection a seat ever receives. The human
UI receives the same projection as the AI seat; an LLM prompt is built only
from its seat's view. There is no path from an LLM request to the full game
state. `apply()` validates every action against the view's `legalActions` and
throws `IllegalAction` otherwise, so a model cannot invent a move or read
another seat's secrets.

---

## 2. Engine contract (`GameDef`, frozen at v1.0)

```ts
setup(ctx)                    // seed + seats + options → state
phase(state)                  // whose turn, phase id/kind/round
view(state, seatId)           // seat projection: data, briefing, chat, legalActions
godView?(state)               // omniscient projection for spectators/replays only
apply(state, seatId, action)  // pure transition; throws IllegalAction
terminal(state)               // finished?
scoring(state)                // winners + per-seat scores
metrics(state)                // game-wide leaderboard numbers
metricsFor?(state, seatId)    // per-seat numbers (e.g. EV loss)
briefing(state, seatId)       // rules + role card for the prompt
secrets(state, seatId)        // tokens that must not appear in this view
roleOf?(state, seatId)        // role/faction label for results
phaseTimeoutMs?(state)        // wall-clock limit, or null
timeoutAction?(state)         // action applied when the limit expires
previewIsPublic?(view, type)  // may in-progress table talk be shown live?
```

Properties enforced by tests and the conformance gate:

- **Deterministic**: same seed + same actions produce the same match. Games
  never read the clock or use unseeded randomness.
- **Pure**: `apply` returns a new state; no game module touches the network or
  filesystem.
- **Replayable**: a match is reconstructed from seed + event log, and the
  rebuilt state is compared against the stored final god view.
- **JSON-safe**: state survives a JSON round-trip (save/resume).
- **Legality-complete**: the acting seat always has at least one legal action;
  illegal actions are rejected; extra fields a model invents are stripped.
- **Privacy tests**: exact-token checks supplement counterfactual tests across
  seat views, private phases, model prompts and action schemas. Live player
  IPC snapshots are also tested to exclude god views.
- **Capability-complete**: declared capabilities imply the UI panels the
  generic renderer needs.

The contract and the results record are frozen at v1.0: additions must be
optional and additive. `npm run lint:games` fails the build if a literal
`gameId` comparison appears outside `packages/games-*`.

---

## 3. Games

### Buckshot Roulette (`packages/games-buckshot`)

A two-seat duel with a shotgun holding live and blank shells. Remaining live
and blank counts are public; the order is not. On a turn a seat may use any
number of items and then must shoot itself or the opponent. A blank shot at
oneself keeps the turn. Three rounds with 2/4/6 health; first to two rounds
wins.

Nine items: cigarette, beer, magnifying glass, handsaw, handcuffs, pills,
burner phone, inverter, adrenaline. Each is implemented with its real effect,
including private peeks that enter only that seat's view.

The oracle scores every decision against an expectiminimax solver over the
belief state (live/blank counts, both item belts, the mover's peek knowledge)
and reports **EV loss per decision** — an objective suboptimality metric rather
than a win rate. Documented approximations: a refilled chamber is assumed
2 live / 2 blank, and a burner phone is modelled as a peek at the next shell.
The oracle is engine-side only and is never reachable from a prompt.

`gauntlet` chains duels against a list of opponents, carrying up to two items
into the next duel.

### Mafia / Werewolf (`packages/games-mafia`)

5–11 seats. Roles by seat count: one mafia for 5–6, two for 7–9, three for
10–11; a doctor always, a detective from 6 seats, a jester from 8. The mafia
confer in a private channel and vote on a kill; the doctor may protect one
seat; the detective learns one alignment. At dawn the result is announced and
the dead seat's role is revealed. The town discusses in seat order (addressed
speech and pass supported), then votes; a tie goes to a runoff between the tied
seats, and a tied runoff kills nobody. The town wins when every mafia is gone;
the mafia win when they equal or outnumber the town; the jester wins by being
voted out.

A seat's view contains its own role, the public log and chat, the mafia channel
only if it is mafia, and investigations only if it is the detective.
`discussionRounds: 0` plays a silent day — the null-chat path the gate
exercises.

### Coup (`packages/games-coup`)

2–6 seats. A 15-card deck holds three each of Duke, Assassin, Captain,
Ambassador and Contessa. Each seat starts with two hidden influence cards and
two coins, except that a duel's starting seat receives one coin. A turn is one
of income, foreign aid, coup, assassinate, steal, tax
or exchange. Claims are public and may be challenged; blocks are public and may
be challenged in turn. A challenge to a proven claim returns the revealed card
to the deck, shuffles, and draws a replacement. A failed challenge to an
assassination refunds the three coins paid. Exchange draws two cards and keeps
as many cards as the seat currently holds. The last seat with influence wins;
a seat with ten or more coins must coup.

The state is a `CoupStep` union: `action`, `challenge`, `block`,
`challenge-block`, `prove`, `lose` and `exchange`. Challenged players can prove
or concede; all other living seats may challenge blocks. Targeted rules and
test cases are documented in [`COUP-RULES.md`](COUP-RULES.md).
The view exposes the seat's own hand,
public coin and influence counts, the pending claim and block, the challenge
queue, the exchange choices and the last 20 public log lines. `godView` adds
all hands and the deck order for spectators and replays. `secrets` emits
`#coup-hand#<seat>#<role>#`, `#coup-deck#<index>#<role>#` and
`#coup-drawn#<role>#` tokens as a supplementary exact-token check. Actual privacy
coverage comes from counterfactual tests which change hidden hands, draws and
deck order while requiring the entire seat view and model request to stay
unchanged. The game declares `uiPanels: ['seat-ring', 'phase-banner',
'action-panel', 'coup-panel']`.

This third game needed no engine changes: it is the practical proof that the
frozen `GameDef` contract covers a bluffing/counteraction genre as well as
Mafia's discussion and Buckshot's expectiminimax.

### Cross-game conformance gate (`packages/sdk-conformance`)

A generic suite every `GameDef` must pass. It runs against Mafia, Buckshot,
Coup and a deliberately tiny toy fixture, so an abstraction shaped around one
genre shows up immediately.

| Check | Catches |
| --- | --- |
| every seat count completes a match | untested ranges, deadlocks |
| same seed and actions produce the same match | hidden nondeterminism |
| replay reconstructs the final state | event-log gaps |
| state survives a JSON round-trip | save/resume breakage |
| illegal actions are rejected | permissive `apply()` |
| the acting seat always has a legal move | soft-locks |
| no seat sees another seat's secrets | role/hand/deck leaks |
| unknown seats are rejected | projection bugs |
| capabilities satisfy the platform contract | missing UI panels |
| a full match plays through the LLM gateway | schema/prompt/parse mismatches (fake transport, zero tokens) |
| results survive the store and produce ratings | stats pipeline regressions |

---

## 4. Agent layer (`packages/agent`)

### OpenRouter client

- Model catalogue from `/api/v1/models`, cached 24 h; the key is checked
  against `/api/v1/auth/key`.
- All traffic goes to `https://openrouter.ai` over TLS; the key travels only in
  the `Authorization: Bearer …` header. Requests carry `HTTP-Referer` and
  `X-Title` for attribution and nothing else.
- Request timeouts are 90 s, retries are capped, and a semaphore allows at most
  six completions in flight so ten seats cannot stampede the key.
- Provider preferences are translated to OpenRouter's snake_case at the HTTP
  boundary.

### Constrained actions

Each request builds a JSON schema from the **exact** legal actions offered to
the seat, so the model can only copy a real option. The response is parsed,
validated against the view's `legalActions`, and stripped of invented fields.
One repair attempt is made, then the engine falls back to a legal move so one
bad model cannot stall the table. Provider error bodies and messages are
redacted and trimmed to 300 characters.

### Prompt safety

Table talk is untrusted input: it is escaped, delimited in `<table-talk>`, and
the system prompt states that chat is never an instruction. Models only receive
their own seat's projection — never the key, filesystem, or other seats' roles.

### Streaming

Completions stream token by token over SSE. While a model writes, the public
`text` field of its action is extracted and sent to the chat as a draft. A
game's `previewIsPublic(view, actionType)` hook suppresses previews for private
channels (for example Mafia night talk); the preview waits for the action type
to arrive and is always cleared when the action lands or the match aborts.
Buffered calls remain the fallback for providers that reject streaming.

### Cost and memory

- Cost is read from OpenRouter's `usage.cost`, metered per seat and per call,
  including streamed calls.
- Each seat keeps notes, counters (calls, tokens, cost, latency, invalid
  actions, fallbacks, errors) and capability flags. `snapshot()` / `restore()`
  persist this across resume, takeover and release.
- A seat may have its own `budgetUsd`; a match or arena may impose a shared
  `SharedBudget`. The shared cap is checked before every call and trips the
  match immediately instead of overspending.

---

## 5. Desktop application (`apps/desktop`)

### IPC surface

The renderer's entire privileged surface is `window.gametable`, defined in the
preload script. `DesktopApi` (`apps/desktop/shared/api.ts`) covers status, key
management, model catalogue, config, games, match control (start/submit/pause/
speed/abort/rewind/takeover/release), events (`onTable`, `onPreview`,
`onFinished`, `onMatchError`, `onDebrief`), replays and seat views, transcript
export, leaderboard, arena, voices, speech-to-text and the data folder.

Every handler is wrapped by a sender check: calls are accepted only from the
app's own top-level `webContents`. Payloads are validated before use
(`apps/desktop/main/validation.ts`): seat counts and kinds, model IDs, name and
persona lengths, budgets, speed, seeds, arena counts, action sizes, takeover
IDs and match ID formats. Invalid requests are rejected with a message, not
coerced into a match.

The renderer runs with `contextIsolation`, `sandbox`, no Node integration and
no remote module. The production CSP is `default-src 'self'; script-src 'self';
connect-src 'self' ws://localhost:5173; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'`; the Vite HMR socket is the only
reason for the `ws://localhost:5173` entry. The renderer makes no network
requests at all.

### Screens

- **Table** — pick a game, add up to ten models (search the catalogue, filter
  free or structured-output models), give each a play style and voice, then
  deal in. "Watch AI vs AI" drops the human seat and reveals everything.
- **Match** — seat ring, role card, night/day log, live vote tally,
  investigations, chat channels, action panel built only from legal actions,
  pause, speed 0.5×–8×, abort, cost meter.
- **Arena** — runs a rotating lineup of models across repeated matches,
  pausable, with a shared budget and per-match results.
- **Replays** — scrub the timeline, play back at speed, reveal all, or view the
  match from any seat's perspective.
- **Leaderboard** — Bradley–Terry ratings from local matches; the human is a
  fixed anchor and never appears on the board.
- **Settings** — key storage mode, budget, voice, local data folder.

### Sessions and persistence

`MatchSession` drives the referee loop: ask the acting controller for an action,
validate and apply it, emit snapshots/events, enforce timeouts and budgets. It
supports pause, speed changes, abort, one-turn rewind (rebuild from seed + log),
and seat takeover/release. A live snapshot is written after every event and
includes the per-seat controller state, so a closed app can resume with each
seat's notes and spend intact.

Replay bundles store seed, seats, options, events and per-action views plus a
god view for the debrief. `formatVersion: 2` bundles validate a rebuilt match
against the stored final god view before projecting seat views; if the stored
options cannot reproduce the recorded match, the app fails loudly instead of
showing a different game. Legacy bundles whose defaults do reproduce the match
still work.

Results are appended to `results.jsonl`; replay bundles and live snapshots live
in the app's private config directory. All writes go through `secureWrite()`
(`apps/desktop/main/secure-file.ts`): `0700` directories, `0600` files, temp
file + rename.

### Voice and speech

Piper (LibriTTS-R, 904 speakers) reads seat messages aloud. Each seat maps to a
stable speaker by default; the Table screen lets you pin one of twelve presets
per model and preview it. The chosen speaker index travels with the match
request and is resolved in the main process — the renderer never receives the
key or runs the synthesiser. Long speeches are read as a sentence-aligned
excerpt to keep lag down. Push-to-talk uses OpenRouter audio-input models for
speech-to-text, tried in order so one unavailable model does not break it.

---

## 6. Security and privacy

The full threat model is in [SECURITY.md](../SECURITY.md); the essentials:

- **Key at rest**: encrypted with Electron `safeStorage` (libsecret/KWallet)
  into `secrets.enc` when a keyring is available; falls back to a plaintext
  `0600` file only when it is not. A plaintext key from an older build is
  migrated on first read and deleted. The settings screen shows the active mode.
- **Key boundary**: the key is read, decrypted and used only in the main
  process. It is never sent to the renderer or written to replays, transcripts,
  logs or crash messages.
- **Redaction**: `redact()` strips `sk-or-…`, `sk-…`, bearer tokens and
  `apiKey` fields from provider errors and anything that can reach the UI or a
  log.
- **Sandbox**: the Flatpak grants network, Wayland/X11, audio, DRI and optional
  keyring access — no home-directory access. Import/export goes through the
  desktop portal file chooser.
- **Hidden information**: the projection boundary protects roles and hidden
  state during play. Replay files contain hidden information and are owner-only.
  Transcript export defaults to public chat and records common to all seat
  projections; selected-seat and omniscient exports require native consent and
  contain explicit sharing warnings. Filtered exports never include raw events
  and fail closed on incompatible replays. The post-game model debrief is
  deliberately omniscient, unlike seat-playing prompts. Backups exclude the
  API key, live sessions and browser state; restore never overwrites an existing
  match ID. Local model prompts go only to the endpoint the user configured.

Not protected against: root or the same user account, a locked/unavailable
keyring (fallback is plaintext `0600`), metadata visible to OpenRouter or a
configured local endpoint by design, and replay/transcript/backup contents at
rest (permission-restricted only).

---

## 7. Build, packaging and release

The Flatpak builds against `org.freedesktop.Platform//25.08`,
`org.electronjs.Electron2.BaseApp//25.08` and the Node 22 SDK extension. The
build is offline: npm tarballs come from `flatpak/node-sources.json` and
Electron's binary is an explicit manifest source. Piper 1.8.0, eSpeak NG and
the CPU-only ONNX Runtime 1.31.0 are compiled from SHA-256-pinned sources;
ONNX dependencies are staged in a local mirror and protoc is source-built.
The voice model is pinned data, with an actual-model build smoke test. See
[`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md) for licensing and release gates.

```bash
./flatpak/generate-sources.sh   # rewrites flatpak/node-sources.json
./flatpak/build.sh              # build, install, write GameTable-fpetersen5_cpu.flatpak
flatpak run io.github.fpetersen5_cpu.GameTable
```

`flatpak/generate-sources.py` works around two generator bugs: 1.0.0 misdetects
every package as a local source when `node_modules` exists, silently dropping
~85 tarballs, and tries to fetch a non-existent Electron `armv7l` build. The
wrapper runs against a clean manifest-only tree and skips the Electron handler.

`flatpak/release.sh` builds and signs a single-file bundle, writes a public key
and a `.flatpakref` with the key embedded, and signs the OSTree repository
summary after installing the new commit — otherwise GPG-verified clients reject
the repo. Output: `GameTable-fpetersen5_cpu.flatpak`, `gametable.gpg`,
`GameTable-fpetersen5_cpu.flatpakref`
and `flatpak/repo/` to upload.

The headless CLI uses the same referee and supports `run`, `gauntlet`, `models`,
`leaderboard` and `games`, with an optional `--oracle` for Buckshot.

---

## 8. Testing and quality gates

`npm run check` runs typecheck, game lint and the full test suite. Coverage includes:

- engine/game unit tests for all three games and the toy fixture;
- the cross-game conformance gate and gateway round-trip;
- counterfactual hidden-state tests, deliberately leaky fixtures, private
  transition logs and live IPC projection checks;
- agent tests for redaction, prompt injection escaping, streaming, previews,
  snapshots, shared budgets, local clients, error classification and probes;
- desktop tests for secret storage/migration/fallback, secure files, validation,
  public/seat/omniscient transcript filtering and native consent, backup
  validation/merge, replay compatibility, arena budgets, seat health and
  resumable session memory;
- renderer tests for the recorder.

Manual verification covers the installed Flatpak: keyring storage and key
validity, match play, token streaming, per-seat voices, replay/resume and the
signed repository install. `GAMETABLE_DEMO=1` runs the whole UI against a fake
transport with no key and no spend; `GAMETABLE_DEBUG_STREAM=1` adds opt-in
streaming diagnostics.

---

## 9. Known limitations

- **One human seat per match**; there is no networked or multi-human play.
- **Cloud provider is OpenRouter**; local seats support unauthenticated
  OpenAI-compatible endpoints. Authenticated local endpoints are not yet
  supported. The endpoint sees the prompts for its seats.
- **Local endpoint reachability**: the app validates http(s) URLs and rejects
  credentials/queries, but a user-configured endpoint can still reach hosts on
  the local network.
- **TTS excerpt**: long speeches are read as a sentence-aligned excerpt, not in
  full, to bound lag.
- **Replay files are not encrypted**, only `0600`; they contain hidden roles and
  private chat. Public-only transcripts exclude private channels and hidden
  state; seat and omniscient exports are private records, not safe public shares.
- **Keyring fallback is plaintext** when no secret service is running; the UI
  states this.
- **Metadata exposure**: cloud model choice, prompts, token counts and timing go
  to OpenRouter by design. Local prompts go to the endpoint you configure.
- **Arena overshoot is bounded, not zero**: the shared budget stops the match,
  but calls already in flight when the cap trips may add a small amount.
- **Flathub readiness**: the opaque Piper binary bundle has been replaced by
  source-build recipes. Final metadata/screenshots, distribution/licensing
  review, public hosting and Flathub acceptance are still separate release gates.

---

## 10. Roadmap

The third game, Coup (2–6 players; bluffing, challenges, blocks), ships against
the frozen contract and is covered by the conformance gate. The game-author
guide in [`docs/WRITING-A-GAME.md`](WRITING-A-GAME.md) is the practical proof
that the SDK is a platform, not a Mafia-shaped abstraction. Remaining:

1. **Flathub submission** after the app is feature-frozen, with the source-built
   speech stack, final metainfo/screenshots and licensing/manifest review.

Deliberately deferred: multi-human/networked play (changes the trust model),
streaming private night talk (correctly suppressed today), full-length TTS,
offline STT, and more game tables before the SDK proof.

---

## 11. Repository map and commands

```bash
npm install
npm run build
npm start --workspace @gametable/desktop

npm run typecheck
npm run lint:games
npm test
npm run cli -- run --game mafia --seats 8 --seed 11
npm run cli -- run --game coup --seats 4 --seed 7
npm run cli -- run --game coup --seats 2 --llm --model llama3.1:8b \
  --base-url http://127.0.0.1:11434/v1
```

Key paths:

- `packages/engine/src/types.ts` — the `GameDef` contract.
- `packages/games-coup/src/coup.ts` — the third game, and the worked example in the guide.
- `packages/agent/src/openrouter.ts` — transport, streaming, retries.
- `packages/agent/src/gateway.ts` — `LlmController`, prompts, snapshots.
- `apps/desktop/main/session.ts` — match loop, resume, rewind, takeover.
- `apps/desktop/main/ipc.ts` — the IPC handlers and sender guard.
- `apps/desktop/main/secrets.ts` — key encryption, migration, fallback.
- `apps/desktop/main/secure-file.ts` — atomic `0600`/`0700` writes.
- `docs/WRITING-A-GAME.md` — the game-author guide.
- `SECURITY.md` — threat model and boundaries.
