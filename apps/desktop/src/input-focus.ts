// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Text fields match :focus-visible even after a pointer click. Track Tab navigation
// separately so pointer focus stays quiet without hiding keyboard focus indicators.
export function initializeInputFocus(): () => void {
  const root = document.documentElement;
  root.dataset.inputFocus = "keyboard";
  const onPointer = () => { root.dataset.inputFocus = "pointer"; };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      root.dataset.inputFocus = "keyboard";
    }
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    delete root.dataset.inputFocus;
  };
}
