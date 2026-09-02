<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# AgentRPC V1 contract

`schema/agentrpc-v1.schema.json` is the transport contract for the client Local
Agent and the central Device Broker. `src/index.ts` contains the TypeScript
types and the small boundary validator used by the Fake Central.

Every device message carries `protocol`, `version`, `timestamp`, `nonce`, and a
typed `payload`. Requests also carry `requestId`; retries of a side-effecting
operation must reuse `operationId`/`idempotencyKey`. The UI compatibility path
may still send the pre-V1 `agent.request` shape, but the gateway converts it to
the versioned envelope before it crosses the device connection.
