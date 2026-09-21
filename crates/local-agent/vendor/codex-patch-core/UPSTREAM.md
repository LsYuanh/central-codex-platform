# Fixed upstream extraction

Origin: https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch

Tag `rust-v0.153.4`, Apache-2.0; LICENSE and NOTICE are copied from this revision.
This is a pure text component linked into Local Agent. It contains no Codex CLI,
App Server, model client, executable helper, executor server or network listener.

Unmodified upstream files: `seek_sequence.rs`, `text_file.rs`.
`streaming_parser.rs` uses standard `assert_eq!` for tests instead of the optional
pretty_assertions rendering dependency; parser behavior and assertions are unchanged.
`parser.rs` removes only PathUri resolution (and its specific test), its imports,
and the test-only `.abs()` wrapper around already absolute tempfile paths.
The parser and its remaining upstream regression tests are otherwise unchanged.
`file_update.rs` retains upstream line matching/replacement and line-ending logic,
accepting verified file text from the caller instead of ExecutorFileSystem. It
omits upstream async I/O and diff rendering wrappers. `lib.rs` retains the needed
upstream data types. No new patch grammar or matching algorithm is introduced.

The platform owns path authorization, snapshots, preconditions, writes and partial
failure reporting. Future upgrades must compare these extraction boundaries to
the pinned upstream and run both upstream text tests and Agent mutation tests.
