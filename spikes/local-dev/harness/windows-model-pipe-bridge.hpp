// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Compatibility entry point for the original QA harness.
#pragma once
#include "../services/windows-worker-host/windows-model-pipe-bridge.hpp"
namespace yuan::qa {
using WindowsModelPipeBridge = yuan::worker::WindowsModelPipeBridge;
}
