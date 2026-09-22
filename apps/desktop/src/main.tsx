// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initializeTheme } from "./theme";
import { initializeInputFocus } from "./input-focus";

initializeTheme();
const disposeInputFocus = initializeInputFocus();
if (import.meta.hot) import.meta.hot.dispose(disposeInputFocus);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
