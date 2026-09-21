// SPDX-License-Identifier: Apache-2.0
// Minimal pure-text extraction of openai/codex apply-patch, commit
// 3d2ee51ca2d5db578f328aa75e20aa22c0197c9a. See UPSTREAM.md.
mod file_update;
mod parser;
mod seek_sequence;
mod streaming_parser;
mod text_file;
pub use file_update::derive_new_contents;
pub use parser::{Hunk, ParseError, UpdateFileChunk, parse_patch};
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ApplyPatchFileUpdateMode {
    #[default]
    NormalizeToLf,
    PreserveLineEndings,
}
#[derive(Debug, PartialEq)]
pub struct ApplyPatchArgs {
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub workdir: Option<String>,
    pub environment_id: Option<String>,
}
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ApplyPatchError {
    #[error("{0}")]
    ComputeReplacements(String),
}
