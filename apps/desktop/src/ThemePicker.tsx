// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useId } from "react";
import type { ThemeMode } from "./theme";

const options = [
  { value: "light", get label() { return t("浅色"); } },
  { value: "dark", get label() { return t("深色"); } },
  { value: "system", get label() { return t("跟随系统"); } },
] as const;

export function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  useLocale();
  const name = useId();
  return <fieldset className="theme-picker" aria-label={t("主题")}>
    {options.map(option => <label key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </fieldset>;
}
