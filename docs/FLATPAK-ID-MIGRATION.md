# Moving from the old GameTable Flatpak ID

GameTable now uses **`io.github.fpetersen5_cpu.GameTable`**, based on the public
GitHub repository [`fpetersen5-cpu/Gametable`](https://github.com/fpetersen5-cpu/Gametable).
The dash in the GitHub name becomes an underscore in the reverse-DNS component.

The old **`io.github.takmikill.GameTable`** install does *not* automatically
become the new app. Flatpak isolates their storage separately. The existing
installation and all its data are left untouched; there is no permission to
read another app's config directory from inside the new sandbox.

## Migrate locally

1. **Close both GameTable apps.** Back up the old directory if you value its
   records: `~/.var/app/io.github.takmikill.GameTable/config/GameTable`.
2. Install `GameTable-fpetersen5_cpu.flatpak` or the signed remote, specifying
   `io.github.fpetersen5_cpu.GameTable`. You do not need to uninstall the old
   app. Do **not** launch the new app yet if you want to migrate its config;
   the migration tool refuses to overwrite newly created settings.
3. From the **host**, in the GameTable source checkout, inspect the dry run:

   ```bash
   python3 scripts/migrate-flatpak-data.py
   ```

4. If the files listed are the ones you expect, copy them explicitly:

   ```bash
   python3 scripts/migrate-flatpak-data.py --apply
   ```

   The script refuses symlinks, live apps and existing destination files. It
   copies only `config.json`, `results.jsonl` and `matches/*.json`, with new
   files mode `0600` and new directories mode `0700`. It does not delete,
   change or overwrite the old records. If it refuses a collision, inspect and
   back up both sides rather than forcing an overwrite. Dry-run is the default.

5. Run the new app and **enter the OpenRouter API key again** in Settings.
   Neither `secrets.enc` nor the plaintext fallback `secrets.json` is copied:
   ciphertext may depend on the old app's keyring/backend, and plaintext must
   not be casually replicated. If you no longer know the key, create/revoke a
   key through OpenRouter as appropriate.
6. Verify configuration, saved matches, voice playback and replays. Some older
   Coup/Mafia replay projections cannot be rebuilt after rule/privacy changes;
   filtered exports fail closed. An explicitly confirmed omniscient export
   may still be available for a saved replay. Only when you have verified
   everything should you consider removing the old install and its data.

`live/` (unfinished matches), Chromium caches, device state, model catalogue,
and keys are intentionally not migrated. The two app identities can coexist.
This host-side opt-in tool needs no new Flatpak filesystem permission.

## For packagers

The new Flatpak manifest, AppStream ID and launchable, desktop entry, icon,
launcher fallback and signed-bundle reference all use the new ID. Do not
silently rename an installed app ID in place or delete the old OSTree ref.
Flathub migration from a *published* old ID would instead need its own
reviewed `provides`/`replaces` and EOL rebase; the old ID was only self-hosted.
