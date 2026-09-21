// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useId } from "react";
import type { ThemeMode } from "./theme";

const options = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

export function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  const name = useId();
  return <fieldset className="theme-picker" aria-label="主题">
    {options.map(option => <label key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </fieldset>;
}
