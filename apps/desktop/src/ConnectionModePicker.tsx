// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useId } from "react";

export type TestMode = "central-gateway" | "local-app-server" | "fake-central";
const options = [
  { value: "central-gateway", get label() { return t("中央网关"); }, get description() { return t("中央运行 Codex，本机执行文件与命令；正式客户端使用此模式。"); } },
  { value: "local-app-server", get label() { return t("本机调试"); }, get description() { return t("仅用于本机 App Server 开发与协议调试，正式客户端不可用。"); } },
  { value: "fake-central", get label() { return t("模拟测试"); }, get description() { return t("Fake Central / AgentRPC：仅验证设备工具与协议，不运行真实推理。"); } },
] as const;

export function ConnectionModePicker({ value, disabled, onChange }: {
  value: TestMode; disabled: boolean; onChange: (mode: TestMode) => void;
}) {
  useLocale();
  const id = useId();
  return <div className="connection-mode-setting">
    <div className="connection-mode-row">
      <span id={`${id}-label`}>{t("连接模式")}</span>
      <fieldset className="theme-picker connection-mode-picker" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} disabled={disabled}>
        {options.map(option => <label key={option.value}>
          <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>)}
      </fieldset>
    </div>
    <p id={`${id}-help`}>{options.find(option => option.value === value)?.description}</p>
  </div>;
}
