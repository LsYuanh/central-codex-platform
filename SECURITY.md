# Security and deployment scope

This project currently targets a trusted LAN. Do not expose the central gateway
(port 4510) directly to the Internet. Use verified TLS and administrator-issued
pairing. Client commands run with the Local Agent's OS account permissions;
the configured output directory is not a filesystem sandbox.

Known implementation and verification limits are documented in
[docs/验证与已知限制.md](docs/验证与已知限制.md). Publishing source does not imply
production isolation, OS signing, notarization or complete platform qualification.

Do not put passwords, tokens, pairing codes, private keys, user documents or raw
diagnostic bundles in public issues. If GitHub private vulnerability reporting is
enabled, use the repository's Security tab to report privately. Otherwise ask the
maintainer for a private contact without disclosing the vulnerability or secrets
in the public request. No response-time guarantee is currently offered.

Public update verification keys and explicitly synthetic test credentials may be
tracked. Production signing keys, TLS private keys, login stores and deployment
profiles must remain outside Git. If a real credential is exposed, revoke/rotate
it before considering history cleanup.
