# Coup rules and regression coverage

GameTable implements base Coup for 2–6 seats, with Duke, Assassin, Captain,
Ambassador and Contessa (three copies each). Rules reference:
[the base rulebook](https://www.qugs.org/rules/r131357.pdf), also available as
[accessible transcribed text](https://www.64ouncegames.com/pages/coup).
Expansion and alternative-deck variants are not implemented.

## Table conventions

- The first seat is the designated starter; play proceeds clockwise and skips
  eliminated seats. A duel's starting seat gets **one coin**, the other gets
  two. With 3–6 seats everyone starts with two coins.
- The app serializes reactions rather than racing concurrent model replies.
  Action challenges and foreign-aid blockers are offered in roster order.
  For a block challenge, the action owner gets the first opportunity, followed
  by the other living rivals. The blocker cannot challenge their own claim.
- Passing a reaction is not the same as passing a turn: taking a turn always
  requires an action. With ten or more coins, that action must be a coup.
- After a challenge, the claimant chooses **Prove** or **Concede**. Prove is
  available only when holding the claimed card. Concede is always available,
  even for a truthful claimant, and the claimant chooses which influence to
  lose. Proving a claim returns exactly that card to the Court, shuffles it,
  and draws one hidden replacement without losing influence.
- A resolved action challenge may still be followed by a block; that block is
  a new claim which any other living seat may challenge. A claim cannot be
  challenged again after its reaction window has closed.
- Revealed losses stay face up and out of play. Exchange draws two cards,
  keeps the player's remaining influence count, and returns exactly two cards
  to the Court. It never restores a lost influence or recycles revealed losses.
- Elimination returns remaining coins to the Treasury. As in the rulebook's
  steal example, an already-pending successful theft is settled before the
  eliminated victim's remaining coins are returned. The transfer occurs once,
  including when that elimination ends the match.

## Targeted regression tests

| Area | Cases |
|---|---|
| Setup | Every seat count; duel coin exception; seeded deal; 15 cards, three copies of each; unsupported counts |
| Basic actions | Immediate income; foreign aid waits for all blockers; 3/7-coin thresholds; mandatory coup at 10+; no turn pass |
| Coup | No challenge or block; victim chooses a card; fee and metric applied once |
| Action claims | Tax, Steal, Assassinate and Exchange: unchallenged bluff; failed bluff; proved claim and replacement; voluntary concession; third-party challenge |
| Blocks | Duke foreign-aid block; Captain/Ambassador steal block; Contessa assassination block; truthful and false blocks; third-party block challenges |
| Costs | Successful assassination challenge refunds the fee; blocking does not; conceding a truthful Assassin claim also refunds the fee |
| Influence loss | Double danger from failed action challenges or false Contessa blocks; chosen card; duplicate cards; eliminated targets and challengers; skipped turns |
| Exchange | Challenge before drawing; one/two influence; exactly two returned cards; retaining the original hand; duplicate combinations; invalid choices; six-seat Court size; fail on a corrupt short deck |
| Continuations | Challenge survivor may still block; proved block survives challenger's elimination; action owner's elimination; pending theft against an eliminated victim |
| Terminal state | One winner, consistent scoring, no phantom next turn, no moves after game over |
| Privacy | Hidden hands/deck/draws; claim-proof capability and replacement card remain private until permitted to reveal |

Files under `packages/games-coup/src/`:

- `rules.test.ts`: targeted action, challenge, block and elimination scenarios.
- `exchange.test.ts`: card selection, multiplicities and Court handling.
- `invariants.test.ts`: continuation edge cases plus **60 complete seeded
  legal playouts** across every supported seat count. Every transition checks
  card conservation, nonnegative integral coins, no coins on eliminated seats,
  immutable inputs, actor legality, monotonic revealed losses, and identical
  state after JSON serialization and replay.
- `privacy.test.ts`: complete view/prompt non-interference and sensitivity to
  deliberate leaks.
- `conformance.test.ts`: the generic SDK gate, including an LLM-gateway match.

Run `npx vitest run packages/games-coup` or `npm run check`.

## Replay compatibility

These corrections change Coup's game version to `1.0.1`; the engine's frozen
`GameDef` interface does not change. Some older Coup event logs may no longer
reconstruct under the corrected setup and reaction sequence. Replay projection
and public/seat transcript export fail closed when the rebuilt record differs;
they do not present a different match as the original. Explicitly confirmed
omniscient transcript export remains available for the stored full record.
