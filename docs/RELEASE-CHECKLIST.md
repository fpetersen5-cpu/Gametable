# Release hardening checklist

The app is still version `0.1.0`. These checks prepare a release; they do not
declare 1.0 or imply Flathub approval.

## Automated gates

- `npm ci`, `npm run check`, `npm run build`, `npm run audit:deps`.
- `python3 -m unittest discover -s flatpak/tests -v` exercises repository-URL
  preflight, exact offline-source comparison, native source pins, Electron
  version synchronization, and neural-audio smoke-test validation.
- CI fails on source-generator errors. It compares the contents of regenerated
  npm sources, ignoring ordering but not changed hashes, URLs or duplicates.
- CI validates AppStream and the desktop entry. Metainfo lists all three games.
- The Flatpak voice module runs `flatpak/modules/smoke-tts.py`: actual CPU
  synthesis with LibriTTS-R speakers 21, 318 and 903, checked for non-silent
  mono 22050 Hz WAV (current Piper's 32-bit float or legacy 16-bit PCM), bounded
  duration and distinct output. Non-finite samples and silent output fail.

## Source-built speech stack

The old `piper_linux_x86_64.tar.gz` bundle is replaced by:

| Component | Source | Build |
|---|---|---|
| Piper | OHF-Voice/piper1-gpl `v1.8.0` | C++ library and CLI; packaging-only CMake integration |
| eSpeak NG | `212928b394a96e8fd2096616bfd54e17845c48f6` | Upstream source revision used by Piper; library and phoneme data |
| ONNX Runtime | `v1.31.0` | CPU shared library; no Python wheels, GPU providers, training or telemetry |
| Voice model | LibriTTS-R medium, 904 speakers | Model data pinned to Hugging Face revision `5041a7a49ae5b3a0f30e6837769eb03fdbb231bd` |

Every download has a SHA-256 pin. ONNX Runtime dependencies are declared in
`flatpak/modules/onnxruntime-sources.json` and staged in its local CMake mirror.
Configuration, compilation, protoc generation and installation run without
build-time network access. Its original dependency SHA-1 values were checked
when establishing the stronger SHA-256 pins. No prebuilt protoc is used.

Piper's upstream CMake downloads dependencies implicitly. The small local
`piper.CMakeLists.txt` instead compiles upstream sources against the separately
built libraries, without changing the synthesis algorithms. The executable
remains `/app/piper/piper`, with compatible speaker, pace and output flags.
The app supplies the eSpeak data path explicitly and bounds each process to
60 seconds. The speech build defaults to three jobs to bound peak memory;
override with `GAMETABLE_BUILD_JOBS` on a suitably provisioned builder.
The eSpeak packaging patch also prevents fetching Sonic when its optional
rate-changing support is explicitly disabled; phoneme data is still compiled
from the upstream source.

Piper/eSpeak are GPL-licensed components, separate from GameTable's MIT
application source; ONNX Runtime is MIT with third-party notices. Component
licenses and the voice model card are installed in `/app/share/licenses/`.
The voice model card identifies the LibriTTS-R dataset as CC BY 4.0. Verify
model redistribution/attribution requirements as part of the submission review.
Do not describe the whole bundled distribution as MIT-only.
For self-hosted distribution, provide the corresponding GPL component sources
and build scripts alongside binaries (or a compliant source offer), not only
the license texts. Flathub's source recipes are available in its packaging repo.

`flatpak/flathub.json` limits submission builds to x86_64, matching the pinned
Electron binary. An ARM build is not claimed; it needs a separate Electron
source/checksum and end-to-end testing before enabling that architecture.

When updating ONNX Runtime, review its `cmake/deps.txt`, update each CPU source
pin/mirror location, and rerun a clean offline build and actual-model smoke
test. `npm audit` does not cover these native components or model data.

## Self-hosted repository

- Set `GAMETABLE_REPO_URL` to the actual HTTPS repository URL, ending in `/`.
  Credentials, query strings, fragments, invalid ports and control characters
  are rejected before building.
- Example domains, reserved test domains and local IPs are rejected by default.
  Set `GAMETABLE_ALLOW_TEST_RELEASE=1` only for a local signing/install test.
  Its `.flatpakref` is **not** a distributable installer.
- Keep and back up the production signing key outside the source tree. The
  existing local development key is not production key-management readiness.
- Upload the signed repository and public key, then test a fresh-machine
  install, update from an earlier build, and signature rejection after tampering.

## Still required before 1.0 / Flathub

Local verification of the source recipes completed: all native components
built in the network-disabled SDK sandbox, and three model speakers passed
the build smoke test. Electron's audio decoder also accepted Piper's streaming
float-WAV format. The stripped ONNX shared library is about 24 MB.

- Choose the final feature scope and synchronize app, package and AppStream
  release versions. Add release notes and the final release tag.
- Provide real public repository hosting and final screenshots with stable URLs.
- Confirm project-ID ownership, software/model licensing, attribution and
  Flathub manifest/linter review. Source-built speech removes the opaque Piper
  binary bundle; it does not itself constitute Flathub acceptance.
- `flatpak/build.sh` refuses a dirty working tree because its git source would
+  otherwise silently omit uncommitted changes. Commit or stash before building;
+  `GAMETABLE_ALLOW_DIRTY_SOURCE=1` is an explicit escape hatch.
 - The public source is now at
  [fpetersen5-cpu/Gametable](https://github.com/fpetersen5-cpu/Gametable)
  (Git over SSH for contributors; HTTPS for Flatpak builders). Both the
  homepage and issue tracker have been checked for public access.
- The Flatpak ID now matches the public GitHub owner:
  `io.github.fpetersen5_cpu.GameTable` (the GitHub hyphen becomes an underscore
  in the reverse-DNS domain component). The former
  `io.github.takmikill.GameTable` installation is a **different app**; it is
  intentionally left installed until users choose to migrate their local
  records. See [`FLATPAK-ID-MIGRATION.md`](FLATPAK-ID-MIGRATION.md).
- Replace the development Git `branch: main` source with the final immutable
  release tag/commit for submission. Local verification of the new app ID
  resolves the public GitHub source; the branch remains the manifest-linter
  blocker before Flathub submission.
- Flathub's current generative-AI policy prohibits AI-generated or AI-assisted
  manifest content in submissions. The packaging edits here were AI-assisted
  and **must not be submitted as-is**: a human maintainer needs to author and
  review the final compliant Flathub manifest independently, disclose known
  AI-generated application/documentation material as required, and submit the
  pull request themselves. An AI agent must not prepare or submit that PR.
- The public repository now includes the MIT `LICENSE` this tree declares, and
  bundled speech/model notices are namespaced under the Flatpak ID. Confirm the
  pushed repository matches before release.
- Complete the remaining bundled model/third-party attribution and licensing
  review for distribution.
- Assess the linter's optional 26.08 runtime upgrade recommendation separately;
  the source build targets the 26.08 runtime.
- Test clean install/update and voice output on supported desktop environments,
  including locked/unavailable keyrings, real OpenRouter models, API failures,
  budget stops, microphone permissions and replay compatibility.
- Document old replay limitations after rule/projection changes; filtered
  exports must continue to fail closed rather than expose private data.
