# Third-Party Notices

Third-party materials retain the licenses and notices listed below. Project-owned
integration code is covered by [LICENSING.md](LICENSING.md).

| Material | Pinned source / license | Local files and modifications |
| --- | --- | --- |
| OpenAI Codex App Server source baseline | [openai/codex](https://github.com/openai/codex), revision in [harness/upstream.json](harness/upstream.json), Apache-2.0 | Upstream is fetched for builds. Archived [LICENSE](harness/upstream/LICENSE) and [NOTICE](harness/upstream/NOTICE); patches, adaptation pins and source inventory are under `harness/`. Runtime distributions must preserve these notices. |
| Codex apply-patch extraction | `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, Apache-2.0 | [UPSTREAM.md](crates/local-agent/vendor/codex-patch-core/UPSTREAM.md) documents modified/unmodified files and extraction boundaries. [LICENSE](crates/local-agent/vendor/codex-patch-core/LICENSE), [NOTICE](crates/local-agent/vendor/codex-patch-core/NOTICE). |
| Tauri NSIS installer template | Tauri CLI 2.11.4, MIT OR Apache-2.0; copyright the Tauri Programme within The Commons Conservancy | [Source and integration details](apps/desktop/src-tauri/windows/nsis/README.md). Unmodified upstream installer, [MIT](apps/desktop/src-tauri/windows/nsis/LICENSE_MIT) and [Apache-2.0](apps/desktop/src-tauri/windows/nsis/LICENSE_APACHE-2.0) texts retained. |
| npm and Cargo dependencies | Versions/integrity in `package-lock.json`, `Cargo.lock`, and `harness/upstream/Cargo.lock` | [Direct dependency overview](THIRD_PARTY.md). Includes React, Tauri, Markdown renderers, KaTeX/fonts, Mermaid, syntax highlighting, Tokio and test tooling. Each dependency retains its own license. |
| Node.js in central runtime packages | Version/license pins in the runtime catalog and packaging inputs | Runtime packaging requires the corresponding Node.js license. It is not project-owned code. |
| Optional Microsoft WebView2 runtime | Version/download/hash in [webview2-runtime.json](apps/desktop/src-tauri/windows/webview2-runtime.json) | Not vendored in Git. Optional packages must retain Microsoft files/notices and comply with the applicable redistribution terms; see the NSIS README. |

Codexia and Soromi were evaluated or used as architectural references. The current
tracked source inventory contains no recorded source import from either project;
do not describe them as imported dependencies without an actual source record.

This inventory is not a complete transitive SBOM or a blanket approval of binary
redistribution. A binary release must include the exact shipped components' license
texts and required notices; the source repository's license does not cover every
bundled component. Existing package staging and signature checks remain required.
