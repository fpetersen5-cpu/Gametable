# GameTable

One human against up to ten AI models, on your own OpenRouter key, packaged as a
Flatpak.

```
┌──────────── Electron main process (Node, network) ────────────┐
│ Referee Engine  ── state machine, seeded RNG, event log        │
│   view(state, seatId)   → projection for the human AND agents │
│   apply(state, action)  → validates; illegal moves rejected   │
│                                                                │
│ Seats: you (IPC) · up to 10 LlmSeats → gateway → OpenRouter    │
└────────────────────────────────────────────────────────────────┘
```

The app is a referee, not a game master. It owns all state and hands each seat
only what that seat may see. The human UI receives the **same projection** as
the AI seats: if you can see it, the model can. That single invariant is what
makes hidden-role games work at all.

## Status

| Milestone | State |
|---|---|
| **M0** — skeleton, Flatpak manifest, key entry, model picker, secret storage, headless CLI | done |
| M1 — engine hardening, agent gateway polish, leak checker in CI | engine + gateway are in place, being hardened |
| **M2a** — Buckshot Roulette: rules, 9 items, expectiminimax oracle, Gauntlet | **done** |
| **M2b** — Mafia / Werewolf: roles, night phases, discussion, votes, runoff | **done** |
| **M2c** — cross-game compatibility gate (GameDef frozen at v1.0) | **done** |
| **M3** — game tables, action panel, spectator cinema, replay, post-game report | **done** |
| **M4** — results store, Bradley–Terry leaderboard, EV-loss ranking | **done** |
| M5 — signed `.flatpak` bundle | manifest ready, build not yet verified on this machine |

Everything is playable in-app now. `GAMETABLE_DEMO=1 npx electron apps/desktop`
runs the whole UI against a fake transport, with no key and no spend.

## Quick start (development)

```bash
npm install
# npm 12 blocks install scripts; Electron needs its binary
npm install-scripts approve electron esbuild   # or: node node_modules/electron/install.js
npm run build
npm start --workspace @gametable/desktop
```

Headless, no API key needed:

```bash
npm run cli -- run --game toy.mines --seats 5 --seed 42
npm run cli -- run --game buckshot --seed 7 --oracle
npm run cli -- run --game mafia --seats 8 --seed 11
npm run cli -- gauntlet --seed 3
npm run cli -- leaderboard --file ./results.jsonl
```

Against real models (uses your own key):

```bash
export OPENROUTER_API_KEY=sk-or-...
npm run cli -- run --game toy.mines --seats 4 --llm --model openai/gpt-4o-mini
```

Checks:

```bash
npm run typecheck
npm run lint:games   # no game-specific branching outside packages/games-*
npm test
```

## Layout

```
packages/engine/           referee, projections, event log, match runner, bots
packages/games-buckshot/   duel rules, items, expectiminimax oracle, gauntlet
packages/games-mafia/      roles, night phases, discussion, votes, runoff
packages/agent/            OpenRouter client, prompt builder, LLM seat, semaphore
packages/stats/            frozen results record, JSONL store, Bradley–Terry
packages/sdk-conformance/  cross-game gate + toy game fixture + fake model
apps/desktop/              Electron main + preload + React renderer
apps/cli/                  headless runner (also the eval harness)
flatpak/                   manifest, metainfo, icon, launcher, build scripts
```

## Buckshot Roulette

A two-seat duel with a shotgun holding live and blank shells. Remaining live
and blank counts are public; the order is not. On your turn you may use any
number of items, then you must shoot — at yourself or at your opponent.
Shooting yourself with a blank keeps your turn. Three rounds with 2/4/6 health;
first to two rounds wins.

Items, all implemented: cigarette (+1 health), beer (eject and reveal the
current shell), magnifying glass (private peek), handsaw (next shot deals 2),
handcuffs (opponent skips a turn), pills (50/50 +2/−1), burner phone (private
peek at a future shell), inverter (flip the current shell), adrenaline (steal
and immediately use an opponent's item).

**Gauntlet** chains duels against a list of opponents, carrying up to two items
into the next duel:

```bash
npm run cli -- gauntlet --models openai/gpt-4o-mini,anthropic/claude-haiku
```

### Optimality metric

`--oracle` scores every decision against an expectiminimax solver over the
belief state (live/blank counts, both item belts, the mover's peek knowledge).
It reports **EV loss per decision**, which is an objective suboptimality number
rather than a win rate. Two documented approximations: a refilled chamber is
assumed 2 live / 2 blank, and a burner phone is modelled as a peek at the next
shell. The oracle is engine-side only and never reachable from a prompt.

## Mafia / Werewolf

5 to 11 seats. Roles are dealt by seat count: one mafia for 5–6, two for 7–9,
three for 10–11; a doctor always, a detective from 6 seats, a jester from 8.
The mafia confer in a private channel, then vote on a kill; the doctor may
protect one seat; the detective learns one alignment. At dawn the result is
announced and the dead seat's role is revealed. The town discusses in seat
order, then votes; a tie goes to a runoff between the tied seats, and a tied
runoff kills nobody. The town wins when every mafia is gone; the mafia win when
they equal or outnumber the town; the jester wins by being voted out.

```bash
npm run cli -- run --game mafia --seats 8 --seed 11
```

A seat's view contains its own role, the public log and chat, the mafia
channel only if it is mafia, and investigations only if it is the detective.
`discussionRounds: 0` plays a silent day — the null-chat path the gate exercises.

## The cross-game compatibility gate

`packages/sdk-conformance` is a generic suite that every `GameDef` must pass.
It runs against all three games (Mafia, Buckshot, and a deliberately tiny toy
fixture), so an abstraction shaped around one genre shows up immediately.

| Check | Catches |
|---|---|
| every seat count completes a match | untested seat ranges, deadlocks |
| same seed and actions produce the same match | hidden nondeterminism |
| replay reconstructs the final state | event-log gaps |
| state survives a JSON round-trip | save/resume breakage |
| illegal actions are rejected | permissive `apply()` |
| the acting seat always has a legal move | soft-locks |
| no seat sees another seat's secrets | leaks of roles, hands, chamber order |
| unknown seats are rejected | projection bugs |
| capabilities satisfy the platform contract | UI panels missing for a declared capability |
| a full match is playable through the LLM gateway | schema/prompt/parse mismatches (fake transport, zero tokens) |
| results survive the store and produce ratings | stats pipeline regressions |

`GameDef` and the results record are **frozen at v1.0**: new fields must be
optional and additive. `npm run check` runs the gate in CI, and `lint:games`
fails the build if a literal `gameId` comparison appears outside
`packages/games-*`.

## Playing in the app

1. **Table** — pick a game, add up to ten models (search the OpenRouter
   catalogue, filter to free or structured-output models), optionally give each
   a play style, then **Deal me in**. **Watch AI vs AI** drops the human seat and
   reveals everything.
2. **Match** — the seat ring shows who is alive, thinking, and (once revealed)
   what they were. In Mafia you get a role card, the night/day log, the live
   vote tally, your investigations, and a chat panel with the mafia channel only
   if you are mafia. In Buckshot you get both health bars, the chamber, your
   item belt, and any peeks you have paid for.
3. **Action panel** — built only from the legal actions the engine offers:
   target buttons for votes and kills, item chips, two big shoot buttons, and a
   text box for table talk. Nothing you can click is illegal.
4. **Live controls** — pause, 0.5×–8× speed, abort, and a cost meter against the
   match budget. Reaching the budget aborts the match instead of overspending.
5. **Post-game** — winners, roles, per-seat cost/tokens/invalid actions, EV loss
   per decision (Buckshot), and a transcript export through the file dialog.
6. **Replays** — every match is stored with a view for each action. Scrub the
   timeline, play it back at speed, and toggle **reveal all** to see the hidden
   state.
7. **Leaderboard** — Bradley–Terry ratings from your own matches. The human is a
   fixed anchor, so a single-model duel still moves that model's rating; the
   human never appears on the board.

### Demo mode

```bash
GAMETABLE_DEMO=1 npx electron apps/desktop
```

A fake catalogue and a fake transport that always answers with a legal action.
Useful for trying the UI, taking screenshots, or checking a change without
spending tokens.

## What a seat sees

A game implements `GameDef` (`packages/engine/src/types.ts`):

```ts
setup(ctx)                   // seed + seats → state
phase(state)                 // who acts now
view(state, seatId)          // ← the anti-cheat boundary
apply(state, seatId, action) // throws IllegalAction
terminal / scoring / metrics / briefing / secrets / roleOf
```

The runner asks each acting seat's controller for an action, validates it
against the view's `legalActions`, and applies it. Anything that is not an
offered action is rejected; extra fields a model invents are stripped before
they reach state. A seat that fails repeatedly gets a fallback move so one bad
model cannot stall the table.

## LLM seats

- Model catalogue from `/api/v1/models`, cached 24 h; key checked against
  `/api/v1/auth/key`.
- Actions are requested as JSON against a schema generated from the **exact**
  legal actions, so the model can only copy a real option. One repair attempt,
  then the engine falls back.
- Table talk is untrusted: escaped, delimited in `<table-talk>`, and the system
  prompt states it is never an instruction.
- Cost is read from OpenRouter's `usage.cost` and metered per seat.
- A shared semaphore keeps ten thinking models from stampeding the key.

## Flatpak

```bash
./flatpak/generate-sources.sh    # needs flatpak-node-generator
./flatpak/build.sh               # builds, installs and writes GameTable.flatpak
```

The manifest uses `org.electronjs.Electron2.BaseApp//24.08` plus the Node 22 SDK
extension, builds fully offline from vendored npm sources, and grants only
`--share=network` (the app is an OpenRouter client), Wayland/X11, audio, DRI and
optional keyring access. There is no `--filesystem=home`; file imports and
exports must go through the file chooser portal.

**Not yet verified:** this machine has no 24.08 SDK or Electron base app
installed and the Flathub remote did not answer, so the Flatpak build has not
been run end to end here. The manifest follows the official Electron Flatpak
guide; the first real build is the next packaging task.

## Security notes

- The API key lives only in the main process. It is written to a `0600` file in
  the app's config directory; the portal Secret backend is the intended upgrade
  (`apps/desktop/main/secrets.ts`).
- The renderer runs with `contextIsolation`, `sandbox` and no Node integration;
  the only surface is `window.gametable`.
- No telemetry. Leaderboard data stays in `results.jsonl` unless you export it.

## Roadmap

Buckshot Roulette with an expectiminimax oracle (leaderboard by EV lost per
decision), Mafia/Werewolf with discussion and voting, the M2c cross-game gate,
then the game tables, spectator mode and replay.
