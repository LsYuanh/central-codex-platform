# Windows optional WebView2 component

`upstream-installer.nsi` is vendored unchanged from Tauri CLI `2.11.4`:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

Upstream is copyright the Tauri Programme within The Commons Conservancy,
dual licensed under MIT or Apache-2.0 (licenses included here). Local integration
code keeps the repository license. This is the existing product's NSIS installer,
not a second installer or application.

`scripts/desktop-webview2.mjs` validates the CLI version, applies narrowly checked
template anchors, and includes `webview2-component.nsh`. The generated template
and Microsoft runtime stay under ignored `target/`. Review the template against
upstream and rerun verification when updating the CLI.

The component page follows the installation-directory page. First installs leave
the checkbox unchecked. `.onInit` reads the previous choice before the reinstall
page can invoke the old uninstaller. Passive and silent updates preserve it;
explicit `/WEBVIEW2=1` and `/WEBVIEW2=0` overrides are supported. Each chosen
directory is inspected again. A selected component skips the system runtime
bootstrapper. Existing RC preinstall/uninstall hooks remain intact.

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

Read-only plan: `node scripts/package-desktop.mjs --plan`.
Prepare/verify runtime only: `node scripts/desktop-webview2.mjs --prepare`.
Neither command creates an application installer. Actual packaging and installed
upgrade verification require the user's separate packaging authorization.
