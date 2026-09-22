# 常规与连接设计提示词

生成方式：内置 `image_gen`，2026-09-22。仅视觉设计稿，非页面代码。

## 深色稿

输入：用户提供的常规与连接截图作为身份与外壳参考。

```text
Use case: ui-mockup. Create a polished HIGH FIDELITY desktop application UI design image for the Chinese Windows app 远舟, page 常规与连接. This is a design proposal, not an implementation screenshot. Output one single front-on full desktop app window, landscape aspect 1200:792, ideally rendered 1800x1188 or higher with the same logical sizes. All Chinese text must be sharp and accurately spelled. No perspective, laptop, photo, background scenery, presentation board, giant headings, annotation arrows, or surrounding margin.
Input image is reference for app identity, shell, typography and navigation ONLY. Completely redesign main settings content according to the following compact layout. Preserve the native 32px Windows title bar and about 304px wide slate sidebar; show whole window edge to edge. Dark theme.
Palette: titlebar/sidebar #20262E, selected navigation #323C47, main #1E1E1E, subtle grouped surface #232323, hairline borders #383838, text #ECECEC, secondary #B4B4B4, tiny green status #8DCAA4. No blue focused borders, no colored glow, no bright white CTA slabs, no large shadows. Grayscale compact controls, 6px button radius, 28px ordinary actions, 32px save action, labels 13px; 14px body, 24px page title, 15px section labels. Native Chinese sans-serif Microsoft YaHei UI / Noto Sans SC, regular weights mostly.
Sidebar exactly: top back arrow and 返回应用; small 设置 label; navigation rows 我的技能, 常规与连接 selected, 对话管理, 诊断, 版本更新. Thin familiar line icons, compact 36px navigation rows. Bottom two tiny green dot rows 中央网关 · 已连接 and 本机设备 · 在线. Do not add sidebar sections.
MAIN DESIGN precise logical geometry: x352 to1152 (800 wide), top y62, title 常规与连接, small secondary subtitle 外观、设备连接与文件保存位置. Main content follows a unified left and right alignment and sits entirely above y720. Do not enlarge spacing to fill window.
1 At y141 small section heading 外观. Below, one unboxed 48px setting row, left 主题 with small helper 立即应用，下次启动时保留. Right compact 28px three segment pill 浅色 | 深色 | 跟随系统; 深色 selected using subtly lighter neutral fill. Thin bottom separator. Do not wrap this single setting in a giant card.
2 At y245 heading 连接与设备; at far right a quiet 28px button 断开连接. Beneath a SINGLE restrained 10px round outlined group, about 156px high. Upper part has two equally sized compact columns separated by a vertical hairline: left tiny server line icon, label 中央网关, small helper 对话与任务处理, right of this half tiny green dot 已连接. Right half laptop icon, label 本机设备, helper 本机文件与命令执行, right green dot 在线. This clearly distinguishes gateway vs device. Lower part separated by a horizontal inset hairline: label 设备配对, below small 已配对 · 示例用户. Right quiet circular refresh icon with label 刷新 and a compact disclosure 连接详情 ›. No permanent verbose address or identifier text. No permission switches. Collapsed connection details contains technical identity and unpair operations; do not invent visible details content in this view.
3 At y463 heading 默认输出目录. One small helper 未指定保存位置时，文档和图片保存到此目录. Beneath at y513 horizontal row: folder icon and wide 32px gray-bordered input showing D:\工作目录 ; right compact 28px 选择目录 button. No blue outline, no glow. Below small muted sentence 此目录仅作为默认保存位置，不限制文件访问范围。 Then a small disclosure 查看当前生效配置 ›.
4 At y613 an aligned action row. Left subdued small 保存后重新连接设备，任务运行时不可修改。 Right small neutral outlined 28px 重新读取 button and restrained slightly lighter neutral filled 32px 保存并应用 button, white text. Button widths just fit labels, approx100px, never giant white slabs.
5 At y690 thin separator and a single low contrast collapsed line 开发选项 with tiny 开发版 badge and right chevron. This exists only in development builds. The distracting current three mode cards are NOT visible in default view. Do not show Local Codex or Fake Central choices anywhere else.
Keep interface professional, dense but comfortable, small refined actions, clean alignment, realistic desktop UI. No marketing ornament, no gradients, no over-sized cards, no new features. Render exact Chinese labels, no English except filesystem path. Reference image is dark but reflow main content fully as specified. Full window visible.
```

## 浅色稿

输入：上一步深色图作为编辑目标，仅切换主题。

```text
Use case: ui-mockup. Produce the LIGHT THEME counterpart of the attached dark desktop settings design for 远舟. The attached image is the edit target. Preserve exactly the same window dimensions, native title bar, navigation order, main content layout, spacings, Chinese labels, small button sizes, icon sizes, directory value, dividers, alignment and content hierarchy. Change ONLY theme colors and the theme selector's selection. Text must remain sharp and accurate Chinese. Keep the full app window visible, no background outside it.
Light theme palette: native titlebar and sidebar #EDF3F8, selected sidebar row #E1E8EE, main #FFFFFF, single grouped connection surface #FFFFFF with #E5E5E5 hairline borders, neutral controls #F3F3F3, regular text #242424, secondary text #626262, status dots/text #267044, weak field border #B8B8B8. Small 保存并应用 button should be neutral #E7E7E7 with dark #242424 text, not black; other buttons quiet white or very light gray with subtle borders. No blue input outline or colored focus glow, no heavy shadows or gradients. Theme segmented control has 浅色 selected (not 深色). Keep example user 示例用户 and example path D:\工作目录. All other labels and controls including 开发选项 / 开发版 remain identical. Keep clean, compact, refined professional desktop UI; do not enlarge or reflow anything.
```

