# Windows optional WebView2 component

`upstream-installer.nsi` is vendored unchanged from Tauri CLI `2.11.4`:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

Upstream is copyright the Tauri Programme within The Commons Conservancy,
dual licensed under MIT or Apache-2.0 (licenses included here). Local integration
code keeps the repository license. Client packaging continues to use the existing
product's NSIS installer; the separate component installer manages only its runtime.

`scripts/desktop-webview2.mjs` validates the CLI version, applies narrowly checked
template anchors, and includes `webview2-component.nsh`. The generated template
and Microsoft runtime stay under ignored `target/`. Review the template against
upstream and rerun verification when updating the CLI.

Default client/updater builds are lean: they do not prepare or bundle any runtime.
The page after the installation-directory page explains reuse and the separate
component package. Existing runtime bytes and the enabled marker remain unchanged.
Lean installers reject `/WEBVIEW2=` overrides instead of silently removing or
pretending to install a component. Missing key files block the update before app
replacement and direct users to component repair. Full builds remain available
with `--with-webview2`, retaining the original default-off checkbox and explicit
`/WEBVIEW2=1|0` overrides.

`.onInit` reads the previous choice before the reinstall page can invoke the old
uninstaller. Manual replacement passes `/UPDATE` to that uninstaller when a private
runtime is selected, including the 0.2.4 uninstaller. The app's normal updater
already uses update mode. A selected component skips the system bootstrapper.
Existing RC preinstall/uninstall hooks remain intact.

`scripts/package-webview2.mjs` builds `webview2-standalone.nsi` with the pinned
runtime version, independent of the client version. It requires the matching
current-user client to be installed, reads its registered directory, rejects unsafe
paths and locked/inaccessible main executables, and does not replace the client or
its uninstaller. The dedicated component tool defaults to installing/repairing;
uncheck its checkbox or pass `/WEBVIEW2=0` to remove. It uses the same staging and
cleanup macros as the full installer. RC builds use the separate RC identity and
fixed directory. No new credential, profile or update service is introduced.

The app checks the private runtime before creating Tauri windows. Its directory
and enabled marker are installer-owned. Runtime replacement stages the new files,
applies AppContainer read/execute permissions, then renames directories. Failure
to activate restores the previous directory. Application data is never stored in
these directories. Standard uninstall removes the component; `/UPDATE` preserves
it. An interrupted transaction can leave `.stage`/`.previous` directories which
the next installer cleans. This is not a transaction for the whole application.

Microsoft runtime download/version/hash is pinned in `../webview2-runtime.json`.
Retain all Microsoft runtime files and notices. Update the pin regularly for
security fixes; fixed versions do not self-update. Before publication, review the
Microsoft redistribution terms and test the exact runtime on Windows 10/11.

Read-only client plan: `node scripts/package-desktop.mjs --plan`.
Read-only component plan: `node scripts/package-webview2.mjs --plan` (or `--rc`).
Prepare/verify runtime only: `node scripts/desktop-webview2.mjs --prepare`.
These commands do not create a distributable installer. Actual product packaging
requires the user's separate packaging authorization.

Regression: `node --test scripts/desktop-webview2.test.mjs`. The opt-in native
fixture test (PowerShell: `$env:YZ_RUN_NSIS_INSTALL_TESTS='1'; node --test scripts/webview2-install.test.mjs`)
compiles tiny synthetic NSIS programs under `target/webview2-install-tests` and
creates/removes a unique `HKCU\Software\YuanZhouRuntimeTests` child. It checks actual
file retention (bytes and timestamps), previous-uninstaller behavior, locked files,
repair/removal and uninstall; it never installs product binaries or a real runtime.
Real 0.2.4-to-next-version product and Win10/11 UI QA remain release checks.
