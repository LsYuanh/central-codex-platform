// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1422, strictPort: true },
});
