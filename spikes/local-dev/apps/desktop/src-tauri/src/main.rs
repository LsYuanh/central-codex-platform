// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run desktop Spike");
}
