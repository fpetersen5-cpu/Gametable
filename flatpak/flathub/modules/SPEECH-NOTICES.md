# Bundled speech components

GameTable's application source is MIT-licensed. The bundled speech components
are separate projects with their own licenses, not MIT-only application code.

- **Piper 1.8.0**, OHF-Voice/piper1-gpl, GPL-3.0-or-later:
  https://github.com/OHF-Voice/piper1-gpl/tree/v1.8.0
  License and bundled third-party notices:
  `/app/share/licenses/io.github.fpetersen5_cpu.GameTable/piper/`.
- **eSpeak NG**, revision `212928b394a96e8fd2096616bfd54e17845c48f6`,
  GPL-3.0-or-later: https://github.com/espeak-ng/espeak-ng
  License: `/app/share/licenses/io.github.fpetersen5_cpu.GameTable/espeak-ng/COPYING`.
- **ONNX Runtime 1.31.0**, Microsoft, MIT, with the additional licenses listed
  in its third-party notices: https://github.com/microsoft/onnxruntime/tree/v1.31.0
  Notices: `/app/share/licenses/io.github.fpetersen5_cpu.GameTable/onnxruntime/`.
- **LibriTTS-R medium English voice**, from rhasspy/piper-voices, 904 speakers:
  https://huggingface.co/rhasspy/piper-voices/tree/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/en/en_US/libritts_r/medium
  Dataset: https://www.openslr.org/141/ (CC BY 4.0 as identified by the model card).
  Model card:
  `/app/share/licenses/io.github.fpetersen5_cpu.GameTable/piper-voice/MODEL_CARD`.

The source recipes, immutable source versions, SHA-256 pins and local build
integration are under `flatpak/modules/` in the GameTable source distribution.
Distributors must comply with each component's licensing and corresponding
source requirements; including this notice alone is not a source offer.
