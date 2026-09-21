# Third-Party Notices

No third-party source code has been imported into this repository at project initialization.

The following projects are being evaluated during the technical Spike and are not yet dependencies:

- Codexia: proposed desktop/App Server integration foundation; target commit and license pending verification.
- Soromi: architecture and selective MIT-licensed implementation reference.
- OpenAI Codex: Apache-2.0 licensed App Server and protocol source/reference.

Before importing code, record the project, repository URL, exact commit or version, license, copyright notice, modified files, distribution method, and any NOTICE requirements here.

## Local development technical Spike

The isolated `.` prototype uses registry-distributed npm and crates.io packages without copying Codexia or Soromi source code. Its direct dependency versions, sources, licenses, and purposes are recorded in `THIRD_PARTY.md`; exact transitive resolutions are captured by its lockfiles after installation. These temporary dependencies are not an approved production baseline.
