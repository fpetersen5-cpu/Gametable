# Writing a game against the frozen `GameDef`

GameTable is a platform, not a Mafia client with two extra games bolted on. A
game is a pure module implementing one interface, `GameDef`, frozen at v1.0 in
`packages/engine/src/types.ts`. The engine owns the match loop, persistence,
replays, the LLM gateway, the human IPC boundary and the conformance gate. A
game owns rules and projections only: no network, no clock, no filesystem.

Coup (`packages/games-coup`) is the worked example in this guide. It was added
after Mafia and Buckshot without changing the engine, the agent layer or the
generic renderer. That is the point.

---

## 1. The contract in one screen

```ts
interface GameDef<S> {
  id: string; name: string; version: string;
  minSeats: number; maxSeats: number;
  capabilities: GameCapabilities;      // what the UI must draw

  setup(ctx: SetupContext): S;         // seed + seats → initial state
  phase(state: S): Phase;              // who acts now
  view(state: S, seatId: SeatId): GameView; // the anti-cheat boundary
  godView?(state: S): GameView;        // spectators/replays only
  apply(state: S, seatId: SeatId, action: GameAction): S;
  terminal(state: S): boolean;
  scoring(state: S): Scoring;
  metrics(state: S): Record<string, number>;
  metricsFor?(state: S, seatId: SeatId): Record<string, number>;
  briefing(state: S, seatId: SeatId): string;
  secrets(state: S, seatId: SeatId): string[];
  roleOf?(state: S, seatId: SeatId): string | undefined;
  phaseTimeoutMs?(state: S): number | null;
  timeoutAction?(state: S): GameAction | null;
  previewIsPublic?(view: GameView, actionType: string): boolean;
}
```

Three rules matter more than the rest:

1. **`view` is the only projection a seat ever receives.** The human UI and
   the LLM prompt builder both consume it. If a secret is in the view, it is
   leaked. `secrets()` is the machine-checkable list of tokens that must never
   appear in that seat's view.
2. **`apply` validates against the view's `legalActions`.** Use the engine's
   `matchAction(legalActions, action)` so an invented field or a stale move is
   rejected with `IllegalAction`. Never trust an action just because it has the
   right `type`.
3. **State must be JSON-serialisable and deterministic.** Replays and resume
   compare a JSON round-trip. Randomness comes from the seed; keep the RNG
   state in the game state (`rngState`) and restore it for every draw. Do not
   read the clock.

---

## 2. Checklist for a new game

- [ ] `packages/games-<id>/package.json` (private, ESM, depends on
      `@gametable/engine`).
- [ ] `packages/games-<id>/src/index.ts` exporting the definition.
- [ ] `packages/games-<id>/src/<id>.ts` implementing `GameDef<S>`.
- [ ] Add a path alias in `tsconfig.json` and a resolver alias in
      `vitest.config.ts`.
- [ ] Register the definition in `apps/desktop/main/ipc.ts` and
      `apps/cli/src/main.ts`.
- [ ] Add a renderer panel for any custom `uiPanels` entry and a `coupData`-
      style guard in `apps/desktop/renderer/game-data.ts`.
- [ ] Add a conformance test that runs `runConformance(def, ...)` and a full
      bot match.
- [ ] Run `npm run typecheck`, `npm run lint:games`, `npm test`.
- [ ] Play one CLI match with `npm run cli -- run --game <id> --seats N --seed S`.

---

## 3. A worked example: Coup

Coup is a bluffing game with hidden hands. The implementation is deliberately
small but exercises every part of the contract.

### State

```ts
interface CoupState {
  seats: SeatRecord[];
  hands: Record<SeatId, CoupRole[]>;
  coins: Record<SeatId, number>;
  deck: CoupRole[];
  discard: CoupRole[];
  turn: SeatId;
  step: CoupStep;          // action | challenge | block | challenge-block | lose | exchange
  log: string[];
  rngState: number;
  stats: CoupStats;
}
```

The hidden information lives in `hands`, `deck` and the two cards drawn for an
exchange. Everything else — coins, influence counts, claims, blocks and the
public log — is public.

### `setup`

Deal two cards to each seat and two coins. The deck is shuffled with
`Rng.fromSeed(ctx.seed)`. Save `rng.snapshot()` in the state so a draw during a
later exchange is reproducible.

### `phase`

Coup is sequential. Return the acting seat and a label such as
`Challenge — Seat 3` or `Lose an influence — Seat 2`. The engine uses
`phase.actor` to choose the controller; there is no hidden turn order.

### `view`

The seat's view contains:

- `data.hand` — its own cards;
- `data.coins`, `data.influence`, `data.players` — public counts;
- `data.pending`, `data.block`, `data.queue` — the public claim/block pipeline;
- `data.log` — the last 20 public lines;
- `data.exchangeCards` — only for the seat currently exchanging;
- `legalActions` — only when this seat must act.

It never contains another seat's hand or the deck order. `godView` adds
`hands`, `deck` and `discard` for spectators and replays only.

### `apply`

`apply` clones the state, checks that the seat is the phase actor, matches the
action against `legalActionsFor(state, seatId)`, then advances the `CoupStep`
union. Every transition is pure and leaves the original state untouched.

The pipeline is:

```
action → challenge queue → block queue → lose influence → next turn
```

A challenge to a proven claim returns the revealed card to the deck, shuffles
it and draws a replacement. A failed challenge to an assassination refunds the
three coins. Exchange draws two cards and keeps as many cards as the seat
currently holds. These are the rules that make Coup feel like Coup, and they
are all in `coup.ts`, not in the engine.

### `secrets`

```ts
secrets(state, seatId) {
  // Other seats' hands, the deck order and any cards drawn by someone else.
  return [
    ...otherHands.map(([seat, role]) => `#coup-hand#${seat}#${role}#`),
    ...state.deck.map((role, i) => `#coup-deck#${i}#${role}#`),
    ...drawnByOthers.map((role) => `#coup-drawn#${role}#`),
  ];
}
```

The leak checker serialises the seat's view and fails if these exact tokens
appear. Synthetic labels alone do **not** detect a raw hand or deck leak:
they do not occur in the underlying role strings. This check is supplementary,
not a proof of privacy.

Use `assertViewNonInterference` from `@gametable/sdk-conformance` with two
valid states that differ only in information hidden from the viewing seat:

```ts
assertViewNonInterference(coup, viewerId, before, after);
```

Keep public facts and the viewer's permitted knowledge fixed. For example,
swap an opponent's card with a card in the deck while preserving hand sizes.
The helper compares the entire seat view, both briefing paths, model prompts
and action schema. Cover each private phase and channel; verify that an
intentionally leaky definition fails the test. Also test positive controls:
the owner still sees their own cards/results, and spectators receive a god view.

### Capabilities

```ts
capabilities: {
  chat: false,
  simultaneousPhases: false,
  items: false,
  health: false,
  solver: false,
  uiPanels: ['seat-ring', 'phase-banner', 'action-panel', 'coup-panel'],
}
```

`seat-ring`, `phase-banner` and `action-panel` are mandatory. Add a panel only
when the game needs it. If `chat` or `items` is true, the matching `chat` or
`item-belt` panel is mandatory too. Declaring a panel the renderer does not
draw is a capability lie; the conformance gate does not catch extra panels, so
keep the list honest.

### Streaming preview

Coup has no table talk, so it omits `previewIsPublic`. A game with public speech
can return `true` only for action types whose `text` is public in every legal
variant. A private whisper must return `false`; the gateway clears the draft
when the action lands.

---

## 4. Registering the game

### CLI and desktop

```ts
// apps/desktop/main/ipc.ts
import { coup } from '@gametable/games-coup';
const games: Array<GameDef<any>> = [mafia, buckshot, coup];

// apps/cli/src/main.ts
const games = new Map<string, GameDef<any>>([
  [mafia.id, mafia],
  [buckshot.id, buckshot],
  [coup.id, coup],
]);
```

The CLI command is then:

```bash
npm run cli -- run --game coup --seats 4 --seed 7
```

### Renderer

The generic table renders `seat-ring`, `phase-banner` and `action-panel` from
the view. A custom panel is a small component that receives the same view:

```tsx
const data = coupData(shown); // guard on a field unique to this game
{data && <CoupPanel data={data} seats={shown.seats} />}
```

Keep the guard narrow: `coupData` checks for `hand` and `deckCount`, so a Mafia
or Buckshot view cannot be mistaken for Coup. The Mafia guard likewise checks
for `yourRole` *and* `votes`, not just `yourRole`.

---

## 5. Testing the contract

Every game must pass the cross-game gate:

```ts
import { runConformance } from '@gametable/sdk-conformance';
import { coup } from './index.js';

const results = await runConformance(coup, { seeds: [1, 2], playoutsPerSeatCount: 1 });
expect(results.filter((r) => !r.ok)).toEqual([]);
```

The gate checks:

- every legal seat count completes a match;
- the same seed and actions reproduce the same match;
- replay reconstructs the final state;
- the state survives a JSON round-trip;
- illegal actions are rejected;
- the acting seat always has a legal move;
- no seat sees another seat's secrets;
- unknown seats are rejected;
- capabilities satisfy the platform contract.

Add targeted tests for your game's rules on top of the gate. For Coup those
cover hidden hands, the challenge/block pipeline, exchange and elimination.

---

## 6. Pitfalls

- **Mutable transitions.** Clone before mutating. A replay compares snapshots;
  mutating in place makes the original state and the replay disagree.
- **Hidden data in the log or phase.** Reveal only what the rules reveal. A lost
  card is public; another seat's hand or night-role actor is not. Test actual
  values and counterfactual hidden states, not only `secrets()` labels.
- **Randomness outside the state.** If you call `Math.random()` or read the
  clock, the replay diverges. Seed and persist the RNG.
- **Trusting action fields.** A model can invent `target`, `role` or `card`.
  Match against `legalActions` and throw `IllegalAction` for anything else.
- **Deadlocks.** If `legalActions` is empty for the phase actor, the match
  stalls. The conformance gate runs every seat count and bot playouts to catch
  it.
- **Unknown seats.** `view` must throw for an unknown seat; do not return a
  partial view.
- **Capability lies.** If you declare `chat` or `items`, the UI must render the
  matching panel. If you declare a custom panel, the renderer must draw it.

---

## 7. What the engine gives you for free

- Seeded match runs and replay bundles.
- Human IPC, LLM controllers and the fake-model transport.
- JSON schema generation from the exact legal actions, plus one repair attempt.
- Redaction, prompt-injection escaping and streaming previews.
- Resume, rewind and takeover.
- Spectator mode via `godView`.
- Results storage and Bradley–Terry ratings.
- The cross-game conformance gate.

If a new game needs a change to `GameDef`, the change must be optional and
additive. A breaking change bumps `ENGINE_VERSION` and moves every shipped
game with it. That is the cost of keeping the platform honest.
