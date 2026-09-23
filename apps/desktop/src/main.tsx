// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initializeTheme } from "./theme";
import { initializeInputFocus } from "./input-focus";
import { initializeContextMenu } from "./context-menu";
import { initializeLanguage } from "./i18n";

initializeTheme();
const disposeInputFocus = initializeInputFocus();
const disposeContextMenu = initializeContextMenu();
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposeInputFocus();
  disposeContextMenu();
});

void initializeLanguage().then(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
));
