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
| M2a — Buckshot Roulette | next |
| M2b — Mafia / Werewolf | next |
| M2c — cross-game compatibility gate | next |
| M3 — game tables, spectator mode, replay | pending |
| M4 — results store + leaderboards | store and Bradley–Terry ratings are in place |
| M5 — signed `.flatpak` bundle | manifest ready, build not yet verified on this machine |

The Table screen currently sets up seats and models; "Deal me in" is disabled
until the first rule sets land.

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
packages/agent/            OpenRouter client, prompt builder, LLM seat, semaphore
packages/stats/            frozen results record, JSONL store, Bradley–Terry
packages/sdk-conformance/  generic GameDef test suite + toy game fixture
apps/desktop/              Electron main + preload + React renderer
apps/cli/                  headless runner (also the eval harness)
flatpak/                   manifest, metainfo, icon, launcher, build scripts
```

## How a seat works

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
