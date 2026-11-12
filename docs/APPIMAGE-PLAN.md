# GameTable AppImage plan

Status: proposed; no AppImage build or compatibility claim yet.

## Target and packaging approach

Ship `GameTable-<version>-x86_64.AppImage` as a self-contained desktop download
alongside the Flatpak. Include Electron, all three games, the 3D Mafia scene,
and the current CPU-only Piper/LibriTTS-R speech stack. Users should not need
Node, npm, Python, Piper or Flatpak installed to play. Local LLM servers remain
user-provided; OpenRouter features still require network access and a key.

Use an explicitly staged **AppDir plus pinned `appimagetool`**. The desktop
already builds into bundled JavaScript and static renderer assets, so this
fits its existing build without another npm packaging layer. Pin the AppImage
runtime as well as the tool; record their versions and SHA-256 hashes. Start
with x86_64 and manual download/replacement updates.

## What the repository already provides

| Existing input | AppImage implication |
|---|---|
| `apps/desktop/build.mjs` | Bundles main/preload; Electron is the only explicit external. Package the generated output rather than the workspace dependency tree. |
| `apps/desktop/vite.config.ts` | Uses `base: './'`, suitable for relocated `file://` assets. Include every renderer asset, including lazy-loaded 3D chunks. |
| `assets/mafia/runtime/` | Tracked 187 MB of 3D character exports; Vite copies it to `dist/renderer/mafia-characters/`. The editable Blender sources are external and not needed for the build. |
| `apps/desktop/package.json` | Product name `GameTable`, version `0.1.0`, Electron pinned to `44.9.3` at planning time. Read these values during packaging. |
| `flatpak/io.github.fpetersen5_cpu.GameTable.yml` | Contains the pinned Electron archive and voice/model metadata hashes. Reuse the source identities and checksums. |
| `flatpak/modules/` | Source recipes for Piper, eSpeak NG and ONNX Runtime, dependency pins, notices and a real synthesis smoke test. |
| `apps/desktop/main/tts.ts` | Supports `PIPER_ROOT`, `PIPER_BIN`, `PIPER_MODEL` and `ESPEAK_DATA_PATH`; defaults currently point at `/app/piper`. |
| `flatpak/gametable.sh` | Depends on `/app`, zypak and Flatpak runtime paths; AppImage needs its own launcher. |
| `apps/desktop/main/main.ts` | Uses Electron `userData`, sandboxed renderers and a keyring-retry relaunch that needs packaged validation. |
| `apps/desktop/main/backup.ts` | Provides a portable backup/restore format for moving records between installations. |

## 1. Establish the compatibility baseline

Do this spike before investing in the full release pipeline.

- Start with an Ubuntu 22.04/glibc 2.35 build-container candidate, pinned by
  image digest. Inspect the pinned Electron binary's actual requirements and
  confirm the native toolchain can build there. Raise the baseline explicitly
  if necessary; building on an older host cannot lower Electron's own ABI floor.
- Rebuild the speech libraries against that baseline. Installed Flatpak
  binaries depend on the Freedesktop runtime and are not portable build inputs.
- Inventory ELF dependencies and required `GLIBC`, `GLIBCXX` and `CXXABI`
  symbol versions with `readelf`/dependency tooling. Bundle required non-base
  libraries with their notices. Keep the host glibc/loader and graphics drivers;
  validate GTK, NSS, audio, X11/Wayland and keyring dependencies on clean hosts.
- Use a generic x86_64 CPU target rather than `-march=native`; record any
  unavoidable CPU requirements from Electron/ONNX Runtime.
- Exercise Chromium's sandbox as a normal user. An AppImage supplies no
  Flatpak-style application sandbox; keep Electron's renderer sandbox,
  `contextIsolation` and disabled `nodeIntegration`. Do not make `--no-sandbox`
  the launcher default. A mounted AppImage cannot rely on a setuid helper.
- Test host user-namespace and AppArmor restrictions, particularly on Ubuntu
  24.04+. A sysctl check alone is insufficient. Record environments requiring
  administrator policy configuration before advertising support there.

**Exit:** an extracted minimal AppDir launches the window with sandboxing on,
and the rebuilt speech executable synthesizes audio on the candidate baseline.
Record the minimum supported distribution/glibc and host package requirements.

## 2. Build a relocatable AppDir

Proposed layout (names below the AppDir are stable across versions):

```text
GameTable.AppDir/
  AppRun
  io.github.fpetersen5_cpu.GameTable.desktop
  io.github.fpetersen5_cpu.GameTable.svg
  .DirIcon -> io.github.fpetersen5_cpu.GameTable.svg
  usr/bin/gametable
  usr/lib/gametable/
    package.json
    dist/main.cjs
    dist/preload.cjs
    dist/renderer/...
    electron/...
  usr/lib/gametable-speech/
    piper
    libpiper.so* / libespeak-ng.so* / libonnxruntime.so* / ...
    espeak-ng-data/...
    voices/en_US-libritts_r-medium.onnx
    voices/en_US-libritts_r-medium.onnx.json
  usr/share/applications/io.github.fpetersen5_cpu.GameTable.desktop
  usr/share/icons/hicolor/scalable/apps/io.github.fpetersen5_cpu.GameTable.svg
  usr/share/metainfo/io.github.fpetersen5_cpu.GameTable.metainfo.xml
  usr/share/licenses/...
  usr/share/doc/gametable/...
```

- `AppRun` resolves its own directory when `APPDIR` is absent, then executes
  `usr/bin/gametable`. Both launch paths must work from arbitrary directories
  and paths containing spaces, forwarding arguments and exit status.
- The launcher supplies bundled speech paths as defaults, preserving explicit
  `PIPER_*`/`ESPEAK_DATA_PATH` overrides. `tts.ts` already adds `PIPER_ROOT` to
  the child process library search path. Use relative `$ORIGIN` RUNPATHs for
  native libraries, including transitive dependencies; keep speech libraries
  out of Electron's global library path.
- Launch the bundled Electron with the packaged application directory. Keep
  the runtime's resources, locales, ICU/V8 data, codecs and license files.
  Verify a minimal staged `package.json` retains `name`, `productName`,
  `version`, `type` and `main`; exclude workspace dependencies and build scripts.
- Build Piper, eSpeak NG and CPU-only ONNX Runtime from the existing pinned
  sources in a separate staging prefix. Adapt `/app` install commands and
  symlinks, and check for references escaping the AppDir. Preserve the offline
  dependency mirror and bounded build concurrency.
- Bundle the ONNX file **and** its `.onnx.json`, phoneme data, model card,
  component licenses and third-party notices. Speech must work offline on the
  first launch without downloading models.
- Ship `three`'s MIT license and any bundled addon notices under
  `usr/share/licenses/`.
- Parameterize `flatpak/modules/smoke-tts.py` with a speech-root argument while
  retaining `/app/piper` as its default. Reuse its real audio validation against
  the staged and extracted AppImage payloads.
- Reuse the current desktop identity and icon. Validate the packaged desktop
  entry and `StartupWMClass` against the running window; keep desktop menu
  installation optional. Do not auto-create a host entry pointing into a
  temporary AppImage mount.

## 3. Storage, relaunch and updates

- Preserve the effective application name `GameTable` and verify that native
  `userData` resolves to `${XDG_CONFIG_HOME:-~/.config}/GameTable`. Explicitly
  stabilize the name early in startup if packaged Electron resolves it
  differently. Never store saves or keys in the read-only AppDir.
- Keep native data outside the Flatpak directory. Migration instructions should
  use Settings backup/export in Flatpak and restore in AppImage, with the key
  entered again. Verify backup contents and existing restore behavior; do not
  copy `secrets.enc` between packaging environments.
- Test GNOME Secret Service and KDE KWallet, plus locked/unavailable keyrings
  and the existing mode-0600 fallback. Confirm the UI reports the actual mode.
- Validate `retryWithLibsecret()` from `main.ts` after an AppImage launch:
  Electron relaunches must survive mount cleanup. If needed, set the relaunch
  executable to the original `APPIMAGE` path and construct arguments without
  retaining the transient mounted application directory. Also test extracted
  AppDir relaunches, where `APPIMAGE` may be absent.
- First-release updates are manual: close GameTable, replace the executable,
  reopen, and retain the same data directory. Document backup before upgrades
  and test replay compatibility. Defer in-app updates/delta metadata until
  hosting and an updater are deliberately implemented.

## 4. Implementation work packages

| Order | Files/deliverables | Completion criterion |
|---|---|---|
| A | `appimage/README.md`, pinned build-container/tool/runtime manifest | Baseline and sandbox spike documented; exact source/tool pins recorded. |
| B | `appimage/build-speech.sh`, shared native source-pin validation, parameterized speech smoke test | Clean source build; actual speakers 21, 318 and 903 pass audio validation outside Flatpak. |
| C | `appimage/AppRun`, `appimage/gametable.sh`, `appimage/build.sh`, metadata staging | Relocatable complete AppDir and versioned AppImage produced from a clean checkout. |
| D | Targeted `main.ts` adjustments only if name/relaunch tests require them; `appimage/tests/` | Storage, launcher argument handling, relocation and keyring relaunch verified. |
| E | `.github/workflows/appimage.yml`, release documentation and README download instructions | CI produces tested artifacts; tagged release contains binary, checksums, notices and corresponding speech sources. |

Source pins should have one authoritative representation or a comparison check
that rejects drift between packaging formats. Avoid unrelated restructuring of
the Flatpak recipes while extracting reusable build steps. Ignore AppDir,
download caches and generated AppImages in `.gitignore`.

## 5. CI and release pipeline

1. Check out the source commit; install with the lockfile using Node 22 as in
   current CI. Run `npm run check`, `npm run build`, `npm run audit:deps` and
   the existing Python packaging/migration checks. Run Electron's installer
   explicitly if install scripts were blocked, verifying its pinned archive.
2. Fetch hash-verified native sources, model files and packaging tools. Build
   native components in the baseline container; compile offline after fetching.
   Cache by architecture, image digest, source hashes and recipe hashes.
3. Stage only allowlisted application/runtime files, build provenance, licenses
   and speech resources. Exclude local results, keys, `.git`, caches and test
   artifacts. Synchronize root/desktop/AppStream release versions and the tag.
4. Validate metadata, ELF dependencies and symlinks; run the speech smoke test
   and an extracted GUI launch under Xvfb as a non-root user. Add a bounded
   readiness check so a crashed or blank window cannot count as a successful
   smoke test. This does not replace real desktop sandbox/audio/GPU testing.
5. Run pinned `appimagetool` with the pinned runtime to create the image. Test
   the final artifact through normal mounting and the chosen runtime's
   `--appimage-extract-and-run` fallback. FUSE availability must be documented
   for that runtime, not assumed from other AppImages.
6. Upload PR/manual-build artifacts without publication credentials. Publish
   tagged releases only after the compatibility gates pass. Include
   `SHA256SUMS`, an authenticated checksum signature using the project's
   release key, build/source provenance, third-party notices and a source
   archive containing the exact GPL speech sources, patches and build scripts.
   Keep release-key handling consistent with the existing release checklist.

## 6. Acceptance matrix

Use fresh users/VMs without developer Node, Piper or Flatpak dependencies.
Record actual distribution versions; this is a test target list, not a support
claim: the selected oldest baseline, Ubuntu 24.04/26.04, Debian stable, current
Fedora, and openSUSE Leap/Tumbleweed. Cover GNOME and KDE, X11 and Wayland.

- Normal mount and extraction fallback; renamed/moved image, spaces in paths,
  unrelated working directory, read-only application directory, clean user
  data, restart and replacement with the next build.
- Sandboxed startup on stock host policies; missing-library diagnostics and
  keyring-triggered relaunch. No root launch or sandbox-disable workaround in
  the passing test path.
- `GAMETABLE_DEMO=1` playthroughs of Buckshot, Mafia and Coup; saved match,
  replay, leaderboard, backup/restore and native file dialogs. Demo mode avoids
  LLM calls but still exercises packaged speech.
- All voice presets play; the real synthesis smoke test passes; output decodes
  in Electron. Check audio output and microphone capture on real desktops.
  Push-to-talk transcription uses OpenRouter and is tested separately online.
- Mafia's lazy-loaded 3D scene renders on a real GPU; verify graceful behavior
  without usable WebGL. Xvfb launch alone cannot prove graphics compatibility.
  Arc A770 baseline: 3.0–4.8 s to a fully loaded 11-character scene, ~69–71 FPS,
  ~410–430 MB renderer working set; verify **Settings → 3D table** off falls
  back to 2D.
- Local-model discovery/play via loopback and an OpenRouter match with a test
  key; confirm budget stops, network errors and secret persistence.
- Flatpak-to-AppImage backup migration and subsequent manual AppImage update
  preserve records; old replay limitations remain documented.

**Release exit:** publish only the environments passing these checks, with
measured artifact size, minimum host requirements, download/run/update steps
and a troubleshooting section for FUSE, user namespaces and keyrings.

## References

- [Existing release checklist](RELEASE-CHECKLIST.md)
- [AppImage manual packaging](https://docs.appimage.org/packaging-guide/manual.html)
- [Electron AppImage sandboxing](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html)
- [AppImage FUSE troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
