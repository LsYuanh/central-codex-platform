// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createRoot } from "react-dom/client";
import { LanguagePicker } from "../../apps/desktop/src/LanguagePicker";
import { message, t, useMessageState, UiError, errorMessage, useLocale } from "../../apps/desktop/src/i18n";
import { nativeMessage } from "../../apps/desktop/src/native-invoke";
import { SidebarSettingsRow } from "../../apps/desktop/src/client-updates";
import { JsonView } from "../../apps/desktop/src/JsonView";
import { MarkdownMessage } from "../../apps/desktop/src/MarkdownMessage";
import { en } from "../../apps/desktop/src/locales/en";
import { nativeEn } from "../../apps/desktop/src/locales/native-en";
import "../../apps/desktop/src/styles.css";

function LanguageQa() {
  useLocale();
  const [notice, setNotice] = useMessageState();
  const [native, setNative] = useMessageState();
  const [raw, setRaw] = useMessageState();
  return <div style={{padding:24}}>
    <LanguagePicker />
    <button onClick={() => {
      setNotice(errorMessage(new UiError("技能 {{p0}} 已更新、停用或移除，请删除标记并重新选择；草稿已保留", {p0:"我的技能"})));
      setNative(nativeMessage("Local Agent 通道不可用：磁盘错误；请重新应用配置"));
      setRaw(errorMessage(new Error("未知远端错误：原文保留")));
    }}>Trigger notices</button>
    <p data-testid="notice">{notice}</p><p data-testid="native">{native}</p><p data-testid="raw">{raw}</p>
    <p data-testid="one">{t("聊天数量", {count:1})}</p><p data-testid="many">{t("聊天数量", {count:2})}</p>
    <SidebarSettingsRow release={{version:"9.0.0"}} openSettings={() => {}} openUpdates={() => {}} />
    <JsonView text="{invalid" streaming={false}/>
    <MarkdownMessage content={'用户原文：设置\n\n```txt\n打印中文\n```'}/>
    <button onClick={() => setNotice(message("已取消归档，可在主页继续聊天。"))}>Success notice</button>
    <details><summary>Catalogue</summary>{Object.keys({...en,...nativeEn}).filter(key=>!/_one$|_other$/.test(key)).map(key=><p key={key} data-catalogue={key}>{t(key as keyof typeof en, {p0:1,p1:2,p2:"detail",detail:"raw",result:"raw",code:"CODE",label:"label",suffix:"suffix",count:2})}</p>)}</details>
  </div>;
}
createRoot(document.getElementById("root")!).render(<LanguageQa/>);
