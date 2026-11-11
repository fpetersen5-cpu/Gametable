# GameTable — repo issues

**Compared:** `/mnt/kioxia/gametable` working tree (uncommitted changes) against
`74ef5a1` (`main`, “feat: overhaul desktop UI”).
**Date:** 2026-11-10
**Scope:** the uncommitted diff plus the current repo state it depends on.
The installed Flatpak is an older `0.1.0` build and was not used for this review.

> **Follow-up fixes (2026-11-10):** all issues below are fixed and committed in
> `c12c7e4` (0.2.0). The Flathub staging pin and screenshots were refreshed in
> `74c4237`.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **379 tests pass** (51 files) |
| `npm run build` | pass; renderer output is **252 MB** |
| `npm run lint:games` | pass |
| Python `flatpak/tests` + `scripts/tests` | 20 pass |
| Electron `file://` fetch probe (Electron 44) | works, including under the app CSP |
| Runtime GUI | launched in demo mode; no JS errors in the log |
| Clean-tree export + `npm ci` + build | pass; 251 MB / 68 files, no source library |
| Missing runtime guard | build fails with a clear error |
| 3D toggle off | scene absent; 2D Mafia panel present |
| 11-seat 3D benchmark (Arc A770) | 3.0–4.8 s load; ~69–71 FPS; ~410–430 MB renderer working set |

## Diff summary

Tracked changes: **27 files, +1559 / −478**. Main areas:

- `apps/desktop/main/session.ts` (+232/−139): seed/resume, budget, takeover/
  release handoff, serialized live saves, save retry.
- `apps/desktop/main/ipc.ts` (+123/−75): provider routing, launch generation,
  config validation, retry-save, per-game leaderboard.
- `packages/agent` + `packages/engine`: abort propagation, 10 s key/catalog
  deadlines, signal-aware semaphore and match runner.
- Renderer: `App`, `MatchScreen`, `ReplayScreen`, `TableSetup`,
  `LeaderboardScreen`, `GameTable`, plus new `useResource`/`async`/`history`
  helpers.
- New 3D Mafia scene: `MafiaScene.tsx`, `mafia-*.ts`, `three` dependency,
  `assets/mafia` (untracked), and the Vite `publicDir` copy.
- New AppImage plan and new tests (`resume-ipc`, `session-*`, `startup-history`,
  Mafia asset/rig tests).

Untracked, therefore **absent from a clean clone**: `assets/` (2.2 GB),
`scripts/mafia/`, `docs/APPIMAGE-PLAN.md`, the new renderer modules, and the new
tests.

## What this diff fixes

Most of the previous review’s high-severity findings are addressed:

- Resume now carries the **actual seed** (`resume.seed`) and reconstructs the match.
- Resume now rebuilds **local model clients** via `createMatchProviders`; all-local
  matches no longer require an OpenRouter key.
- Live writes are serialized (`liveWrites`), so resume snapshots cannot land out
  of order.
- `Abortable` removes its abort listener; model calls receive the run signal.
- `release` rejects the pending human request with `SeatReleased`; `actForSeat`
  retries with the restored model controller.
- Budget is checked before every call and before repairs/debrief; `appendOnce`
  prevents duplicate leaderboard records after a save retry.
- Save failures keep recovery data and expose **Retry saving**; the post-game
  screen disables replay/export until saved.
- `checkKey` / `listModels` now have 10 s deadlines; startup has a 20 s deadline
  and a retry screen.
- `config:load` validates settings instead of silently merging malformed JSON.
- Resume errors are shown beside the recovery list; all unfinished matches are
  listed.
- Replay and leaderboard screens have filters, loading/error states and retries.
- `TableSetup` now says **Add** seats when below a fixed-seat minimum, preserves
  zero budgets, and catches start/refresh failures.
- The debrief failure path now clears `debriefExpected` instead of leaving
  “Analysing…” forever.

## Resolution status (2026-11-10)

| # | Issue | Status |
|---|---|---|
| 1 | Untracked 2.2 GB assets | Fixed: runtime-only tracking; sources ignored; build guard. |
| 2 | 251 MB runtime / GPU cost | Fixed: ship-as-is accepted; 3D toggle; benchmarked and documented. |
| 3 | Keyring `basic_text` misreported | Fixed: backend detection, plaintext migration, docs/tests. |
| 4 | Arena pairings repeat | Fixed: adjacent wrap pairs; test. |
| 5 | Arena timeout drops spend | Fixed: timeout/cancel add `budget.spentUsd`. |
| 6 | `resume.state` ignored | Fixed: replay is verified against the saved state; mismatch fails loudly. |
| 7 | Budget serializes calls | Accepted/documented: Settings and README state the latency trade-off; concurrency remains a follow-up. |
| 8 | `three` license missing | Fixed: Flatpak installs it; AppImage plan includes it. |
| 9 | Flathub pin/screenshots stale | Fixed: fresh 1440×810 screenshots; manifest pinned to `c12c7e4` in commit `74c4237`; lint/appstream/desktop checks pass. |
| 10 | Buckshot stars swapped | Fixed: viewer-perspective helper; test. |
| 11 | “No hidden information” copy | Fixed. |
| 12 | Persona/name save failures | Fixed: `maxLength`, budget caps, visible save errors. |
| 13 | Long model names block start | Fixed: names truncated to 64. |
| 14 | Voice chain dies on error | Fixed: per-clip catch, enabled check, no backlog replay. |
| 15 | Leave hides running match | Fixed: leave pauses and keeps the live snapshot/rail entry. |
| 16 | Backup result validation | Fixed: validates seats, winners and metric numbers; tests. |
| 17 | Leaderboard claims/metrics | Fixed: table/team weighting, EV-loss ratio, corrected copy; tests. |
| 18 | Oracle misses reload | Fixed: refill before pass; regression test. |
| 19 | Inverter stale peek | Fixed: updates both seats’ top knowledge; test. |
| 20 | `view()` purity | Fixed: copies in Buckshot/Mafia/Coup; tests. |
| 21 | `will-navigate` file:// | Fixed: only the app index (or dev origin) may navigate. |
| 22 | Unbounded `Retry-After` | Fixed: 30 s cap; test. |
| 23 | 3D context loss | Fixed: `webglcontextlost` stops rendering and offers retry. |
| 24 | 3D raycast cost | Fixed: one low-poly picking proxy per seat. |
| 25 | 3D constructor leak | Fixed: constructor disposes renderer/assets on failure. |
| 26 | Accessibility | Fixed: lighter `--faint`, larger labels, dialog role/focus trap/Escape. |
| 27 | Renderer error handling | Fixed across App, Arena, Settings, TableSetup and match commands. |
| — | Low-severity items | Fixed: secure catalog write, replay format constant, resume validation, action guard, integer TTS voice, status cache, spoiler-safe replay default, 1100 px breakpoint, Python requirements, version 0.2.0/metainfo. |

## Blockers / high severity

### 1. The new 3D feature depends on 2.2 GB of untracked assets

`git ls-files assets` returns **0 files**, while `assets/mafia` is **2.2 GB**
(`runtime/` alone is **251 MB**). `vite.config.ts` copies
`../../assets/mafia/runtime` into every renderer build.

Consequences:

- A clean clone / CI / Flatpak build has **no character assets**; the 3D scene
  falls back to its error state.
- Committing the source library will hit GitHub limits: several `.glb` files are
  **93–128 MB**, over the 100 MB per-file limit. The `.blend` sources are larger.
- `scripts/mafia/*` (the reproducible asset pipeline) is also untracked.

**Fix:** decide the asset strategy before merging:
- commit only `runtime/` (individual files are < 100 MB) and keep the editable
  sources in Git LFS or an external release, or
- add the runtime as explicit Flatpak/AppImage sources and document the download.

**Resolution (2026-11-10):** runtime-only tracking chosen. `.gitignore` excludes
`assets/mafia/characters/`; `assets/mafia/runtime/` is the tracked payload.
`vite.config.ts` now fails the build if the runtime manifest is missing or any
character listed in it lacks a `.gltf`/`.bin` pair. `assets/mafia/README.md` and
`docs/APPIMAGE-PLAN.md` document the split and the 251 MB payload. The Flatpak
manifest installs the `three` license.

### 2. 251 MB of runtime assets in every build

`apps/desktop/dist/renderer/mafia-characters` is **251 MB**; the renderer build
is 252 MB total. The Flatpak grows from ~178 MB to ~230–340 MB (the untracked
`GameTable-blender*.flatpak` files confirm this), and the AppImage would be
similar. The scene also loads 11 high-poly characters with 2K PBR maps, a
2048² shadow map, a planar reflector and a 34-tower skyline.

**Risks:** long first load, high GPU/RAM use on integrated graphics, and a large
download for a tabletop game.

**Fix:** measure on the minimum supported GPU; consider lower LODs, 1K textures
for distant seats, compressed texture formats (KTX2/Basis), and lazy-loading only
the seats in the current match. Document the minimum GPU/RAM in the README.

**Resolution (2026-11-10):** ship-as-is chosen. The 251 MB runtime is the
accepted payload. A **Settings → 3D table** toggle now falls back to the 2D
table without loading the scene. Measured on an Arc A770 (11-seat Mafia,
1069×466, DPR 1): 3.0–4.8 s to a fully loaded 11-seat scene, ~69–71 FPS,
~410–430 MB renderer working set (peak ~610–650 MB), ~195–255 MB GPU process.
README and release notes document this and recommend a recent discrete GPU.
LOD/compression remain follow-ups.

### 3. Keyring detection is still wrong on Linux without a secret service

`apps/desktop/main/secrets.ts:29-40` treats
`safeStorage.isEncryptionAvailable()` as proof of keyring encryption.
`main.ts:65-78` does the same, and `SettingsScreen.tsx:112` labels the result
“OS keyring (encrypted with safeStorage)”.

Electron’s docs state that with no secret store Linux uses the **`basic_text`**
backend, which encrypts with a hardcoded password; `isEncryptionAvailable()` can
still return true. The app never checks `safeStorage.getSelectedStorageBackend()`.
`SECURITY.md:19-32` therefore overstates the protection.

**Fix:** treat `basic_text` (and `unknown`) as the plaintext fallback or show an
explicit warning; update the Settings copy and `SECURITY.md`. Also plan the
async `safeStorage` migration (sync API deprecated in Electron 44, removed in 46).

### 4. Arena duel pairings still repeat for 4+ models

`apps/desktop/main/arena.ts:337-347` rotates the lineup and then indexes it again:

```ts
const first = lineup[index % lineup.length];
const second = lineup[(index + 1) % lineup.length];
```

For four models the sequence is `A-B, C-D, A-B, C-D`; B-C and A-D never meet.
The UI promises “duels, pairings rotate”.

**Fix:** use `lineup[0]` / `lineup[1]` after rotation, or index the unrotated
list directly. Add a test that every pair appears for 4–6 models.

### 5. Arena timeout still drops the match’s spend

`arena.ts:298-317`: when the 10-minute `matchSignal` timeout fires, the result is
recorded with `costUsd: 0` and the run continues. The same undercount happens on
cancel. The arena total can therefore exceed `totalBudgetUsd` without showing it.

**Fix:** add `budget.spentUsd` in the timeout and cancel branches; add a test.

### 6. `resume.state` is still ignored

`session.ts:285-290` accepts `resume.state` but then calls
`replayAndCapture(resumed.events)` and never uses the saved state. The seed fix
makes replay correct in normal operation, but the saved snapshot is the
authoritative recovery record and should be used (or verified) directly.

**Fix:** use `resume.state` as `initialState` when present; if replay is kept for
verification, compare the rebuilt state to `resume.state` and fail loudly on a
mismatch. Remove the dead field otherwise.

### 7. `Budget` serializes every model call

`apps/desktop/main/budget.ts:36-46` wraps each client in a `Semaphore(1)`, so all
seats in a match call models **one at a time**. This is documented in the README
(“Model calls run one at a time per match”) and tested, but it is a major latency
trade-off: a 10-seat Mafia night that used to fan out all actors concurrently now
takes up to 10× longer. The desktop session never used the gateway’s own
semaphore, so this is the only concurrency limit in that path.

**Fix (if latency matters):** reserve budget before a call and settle the actual
cost afterwards, allowing bounded concurrency; or keep serialization but make
the UI/README state the expected match duration and offer a concurrency setting.

### 8. `three` license is not shipped

`apps/desktop/package.json` adds `three` (MIT) as a runtime dependency, but the
Flatpak/AppImage license installs only the app `LICENSE` and Electron licenses.
The bundled MIT notice must be included.

**Fix:** install `node_modules/three/LICENSE` (and any addon notices) into the
Flatpak/AppImage license directory and the AppImage plan.

**Resolution (2026-11-10):** `flatpak/io.github.fpetersen5_cpu.GameTable.yml`
now installs `node_modules/three/LICENSE`; `docs/APPIMAGE-PLAN.md` includes it.
Regenerate the Flathub staging manifest after the commit.

### 9. Flathub staging and screenshots are stale

`flatpak/flathub/io.github.fpetersen5_cpu.GameTable.json:248` is pinned to
`2a12e4e`, which predates the UI overhaul and the 3D scene. The screenshots in
`flatpak/screenshots/` were added in `9a18de3`, before the overhaul.

**Fix:** regenerate the Flathub staging manifest with the current commit and
replace the screenshots before treating that draft as current.

**Status (2026-11-11):** fixed. The three screenshots were regenerated at
1440×810 from the 0.2.0 build, and the staging manifest is pinned to `c12c7e4`
in commit `74c4237`. `flatpak-builder-lint` (manifest and appstream),
`appstreamcli validate` and `desktop-file-validate` all pass. Push `main` before
submission so Flathub can fetch the pinned commit and the screenshots.

## Medium severity

### 10. Buckshot round-win stars are swapped for seat 2

`apps/desktop/renderer/components/BuckshotPanel.tsx:36,73` always uses
`roundWins[0]` for “you” and `roundWins[1]` for “them”. If the viewer is seat 1,
the stars are reversed. Derive the indices from `viewSeatId`/`humanSeatId`.

### 11. “No hidden information” is false

`apps/desktop/renderer/screens/TableSetup.tsx:331` says
“Your seat. Your decisions. No hidden information.” In Mafia/Coup the human has
a hidden role/hand. Change it to “You see exactly what your seat may see.”

### 12. Persona/name inputs can silently fail to save

`TableSetup.tsx:362` (persona) and the human-name input have no `maxLength`;
`validateConfig` caps persona at 200 and names at 64. Typing past the cap makes
`config:save` reject, and `void onChange(...)` never shows the error. Add
`maxLength` and surface save failures.

### 13. Long model names can block match start

`TableSetup.tsx:76` uses the catalogue `model.name` as the seat name;
`validation.ts:123` caps names at 64 characters. Some OpenRouter names are
longer. Truncate or use `shortModel`.

### 14. Voice playback can die permanently after one TTS error

`apps/desktop/renderer/voice.ts:53-67`: a rejected `window.gametable.speak`
rejects the shared `chain`, so every later `.then` callback is skipped. Turning
voice off pauses only the current clip; queued clips still play. Catch errors
inside the chain and check `enabled` before playing.

### 15. “Leave” hides a running match

`MatchScreen.tsx:123-124` calls `onExit`, which sets `snapshot` to null
(`App.tsx:271-276`). The match keeps running and spending, and the rail’s “Live
match” button is disabled because there is no snapshot. Pause/abort on leave, or
keep the snapshot and the rail entry.

### 16. Backup result validation is incomplete

`apps/desktop/main/backup.ts:77-84` validates only `matchId`, `gameId` and
`seats`. `winnerSeats`/`metrics` are assumed by `bradleyTerry`
(`packages/stats/src/ratings.ts:75-108`); a malformed imported record can crash
the leaderboard. Validate the fields the ratings code uses, or make
`bradleyTerry` defensive.

### 17. Leaderboard claims still exceed the implementation

`LeaderboardScreen.tsx:19` says “adjusted for seat count and role”, but
`ipc.ts:833` calls `bradleyTerry(records)` with no weight; the `weight` hook in
`ratings.ts:19-20,33` is unused. The board is now per-game (good), but there is
still no role/seat adjustment. `evLossPerDecision` is an average of per-match
averages (`ratings.ts:172-174`), not total EV loss / total decisions.

**Fix:** implement the weighting or change the copy; compute EV loss as
`sum(evLoss) / sum(decisions)` per model.

### 18. Buckshot oracle still misses a reload after a pass

`packages/games-buckshot/src/oracle.ts:111-138`: `refill()` is called only for a
blank shot at self. If the last shell leaves on a live shot or an opponent shot,
the oracle models an empty chamber instead of the real 2/2 reload. This weakens
the “exact” EV-loss claim. Call `refill(n)` before the pass recursion and add a
test.

### 19. Inverter leaves the opponent’s peek knowledge stale

`packages/games-buckshot/src/buckshot.ts:290-297` updates only
`knowledge[p].top`. If the opponent had peeked the top shell, their `top` still
shows the old type. Update or clear both seats’ top knowledge.

### 20. `view()` purity violations

`buckshot.ts:488` returns `youPeeked: state.knowledge[p]` by reference;
`mafia.ts:813` returns `roles: state.roles`; `coup.ts:705` returns
`hands: state.hands`. A caller can mutate game state through a view. Copy these
values.

### 21. `will-navigate` allows any `file://` URL

`apps/desktop/main/main.ts:48-50` lets a local HTML file load in the main window
with the preload API. Restrict navigation to the app’s own `index.html` (or deny
all navigation).

### 22. `retry-after` is unbounded

`packages/agent/src/openrouter.ts:374-379,410-415` can sleep for hours if a
provider sends a large `Retry-After`. Cap it (e.g., 30 s) and keep the sleep
abortable.

### 23. 3D scene has no runtime/CI coverage and no context-loss handling

The asset/rig tests are good, but the actual `MafiaDiorama` WebGL path is not
exercised in CI. `MafiaScene` catches constructor failures, but there is no
`webglcontextlost` handler; a lost context leaves a frozen canvas. Add a
`webglcontextlost`/`webglcontextrestored` path and a manual GPU smoke test to
the release checklist.

### 24. 3D raycasting is expensive

`MafiaDiorama.onPointerUp` raycasts every mesh of every high-poly character
(`pickable`). A click can be slow on integrated GPUs. Use one low-poly picking
proxy per seat (or a bounding box) instead of the render meshes.

### 25. `MafiaDiorama` can leak on constructor failure

If the constructor throws before `tableReflection` is assigned, `MafiaScene`
shows the error but never calls `dispose()`, leaving the renderer/PMREM target
allocated. Wrap construction in a try/catch that disposes partial state.

### 26. Accessibility of the new UI

`--faint` (`styles.css:12`, `#626c79`) on `#0b0d11` is ~3.7:1 and is used for
8–10 px labels (`.game-kind` 8 px, `.seat-sub` 9 px, `.rail-label` 10 px). The
new modals still lack `role="dialog"`, a focus trap and Escape handling. Raise
the contrast/size and add dialog semantics.

### 27. Renderer error handling is still uneven

Many `void promise` / `.then(...)` calls have no `.catch`:
`App.tsx:245-249`, `LeaderboardScreen.tsx:9,23`, `ReplayScreen.tsx:18,26-38,64-81`,
`ArenaScreen.tsx:29,59-70`, `SettingsScreen.tsx:37-65`,
`TableSetup.tsx:91-102,137-157`. IPC rejections become unhandled promises and the
UI silently does nothing. A shared error boundary/toast would cover these.

## Low severity / polish

- `apps/desktop/main/catalog.ts:27-30` writes the model cache with plain
  `writeFile`, not `secureWrite` and not atomically. Not secret, but inconsistent
  with “all writes go through secureWrite”.
- `arena.ts:268` hardcodes `formatVersion: 2` instead of `REPLAY_FORMAT_VERSION`.
- `session.ts:569-572` clears `pendingHuman` without rejecting the promise; a
  phase change can leave a dangling 30-minute `withTimeout`.
- `match:resume` does not validate `saved.request`/`saved.seats`; a corrupt live
  file can throw.
- `match:action` calls `JSON.stringify` without a guard; circular/BigInt payloads
  reject the handler.
- `tts:speak` accepts non-integer voice values; round/validate them.
- `app:status` re-checks the key on every call; a short TTL cache would reduce
  startup latency.
- Replay defaults to “God (all roles)”, revealing everything before the user
  picks a perspective; the original plan called for spoiler-guarded reveal.
- `@media (max-width: 1000px)` is unreachable because the window minimum width is
  1024.
- `scripts/mafia` has no `requirements.txt`/environment pin for Pillow/NumPy; the
  README commands assume a prepared Blender/Flatpak environment.
- `docs/APPIMAGE-PLAN.md` is still proposed; it should mention the 251 MB asset
  payload, the `three` license, and the verified `file://` asset loading.
- The metainfo release notes/version still say “First public build” / `0.1.0`;
  a UI overhaul plus a new 3D scene warrants a version bump and release note.
- The README’s “Model calls run one at a time per match” is accurate but should
  also state the latency implication for 10-seat games.

## Suggested order

1. Decide and implement the asset strategy (tracked runtime + LFS/external
   sources); make a clean-clone build reproduce the 3D scene.
2. Fix the keyring `basic_text` detection and update the security copy.
3. Fix arena pairings and timeout/cancel cost accounting.
4. Use `resume.state` (or verify replay against it) and add a regression test.
5. Add the `three` license and refresh the Flathub pin/screenshots.
6. Address the medium UI/leaderboard/oracle items, then the low-severity polish.
