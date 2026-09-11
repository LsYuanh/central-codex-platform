# P4 附件、输出与历史兼容验证

本专项复用 `harness-history-live-smoke.mjs` 的真实中央 4529、独立 Windows Agent 和必要的兼容模型 Turn。`scripts/harness-artifact-history-smoke.mjs` 是可导入 helper，不建立第二条客户端连接、不新增模型调用，也不负责归档或进程清理。所有测试文件均在该历史测试的唯一 fixture 内；不访问安装版、正式 4510 或个人文件。

## 接口和验证范围

`prepareArtifactFixture({ipc, fixture, deviceId})` 经实际 Agent IPC 创建唯一文本附件，以实际 `file/stat` 结果构造引用，并返回供既定模型 Turn 使用的附件、目标输出路径、精确内容和兼容 `codexia.files/write_text` 提示。成功元数据必须来自这次真实提交和客户端工具结果，不预置伪造的已发送/已保存历史。

`verifyArtifactHistory({...prepared, request, ipc, threadId, phase})` 执行：

- 经真实网关 `conversation.read` 读取原生 Turn、attachmentSubmissions 和 outputs，核对附件已发送、输出已保存，并属于同一个真实 Turn、设备和设备身份。
- 调用现有 `messagesFromThreadRead` 恢复 UI 数据，确认附件/输出各只出现一次、路径与版本原样保留、内部提交标记不进入消息正文。
- 经网关和实际 Agent 重新读取 `file/stat`、带版本的 `file/read_text`，对比 Windows fixture 文件内容、UTF-8 字节数、版本和 SHA-256；旧版本必须明确拒绝。
- 经同一个原生附件 IPC 保存到新的 fixture 副本，校验返回摘要和实际磁盘内容；重复保存同样字节保持幂等，无覆盖许可或版本过期的覆盖被拒绝，正确版本覆盖仅修改该副本。
- 返回身份、路径、版本、字节数和摘要 snapshot。历史测试在归档/恢复后以 `previousSnapshot` 再调用，要求完全等价；用 `verifySaving:false` 避免重复副本操作。

helper 不切换工作区、不改源附件或原输出。所有已有文件在读取前同时检查声明路径及 realpath 均在唯一 fixture 内；测试产物保留供审计，由上层测试拥有其生命周期。

## 验证记录

- `node --check scripts/harness-artifact-history-smoke.mjs`：通过。
- Node 24 实际导入两个 helper：通过。
- `npm run history:smoke`：既有用户/助手历史、图片附件历史及旧图片输出卡片恢复通过。
- 真实 4529 联合历史测试：`harness-history-live-smoke.mjs` 完整 exit 0；`artifact-before-archive` 与 `artifact-restored` 两次 helper 均通过。测试 Thread 为 `01a084a8-1dd8-7bf3-a77a-35a88387c7e9`，用户/设备为 `harness-history-1f3a0779-16d2-437f-840f-ed49fa328f10`，独立 fixture 目录名为 `codex-harness-history-Hz3XtD`。

完整 fixture 为 `C:\Users\developer\AppData\Local\Temp\codex-harness-history-Hz3XtD`，实际附件/输出所属 Turn 为 `01a084a8-34d0-7042-ab90-85a5962cfc64`。真实输出位于该 fixture 的 `artifact-history-afa7cc03-f12c-408b-85f0-d976954d54a4/client-result.txt`，附件为同目录 `client-source.txt`；保存副本为 `artifact-copy-7b0795b3-c9e2-4665-b2f5-daf6ea1fcc12.txt`。helper 在实际磁盘核对完整绝对路径、内容和 SHA-256；归档恢复后快照相等，未修改源附件或原输出。测试负责人确认 Agent 已退出，Thread 已归档。证据为该次 exec session 95378 的 exit 0 和两阶段 `ok:true` 输出，没有额外保存完整模型日志。

联合脚本的运行方式和旧工具表样本边界见 `harness-history-live-validation.md`；这次附件与输出数据来自同一次真实模型 Turn，没有为本 helper 追加推理。

最终网关包和 Windows Job Agent（SHA-256 `3CCF62FD08A79EBE0B35ACC7186BC86556E381E2275200C492AB75908571C0E8`）再次通过联合验收。
Thread 为 `01a084b2-4cb9-7fa2-84f2-95729792c1dc`，附件/输出 Turn 为 `01a084b2-6739-7101-a1e4-8ecfbbf2d413`；
完整路径、摘要与两阶段快照记录在 `C:\Users\developer\AppData\Local\Temp\codex-harness-history-uVthGO\history-result.json`。
旧版本记录保留作为实施过程证据，最终 Thread 已归档、Agent 已退出。

本专项没有 UI 源码改动，无需重复原生窗口生命周期验收。此次真实模型场景验证文本附件和客户端文件输出；新图片生成仍按 Harness 能力声明禁用。既有图片历史恢复的静态覆盖不等同于本轮重新验证图片生成、完整传输和保存链路。

既有 `MessageAttachment` 不携带独立 `deviceKey`；图片历史预览检查来源 deviceId 和文件 version。输出卡片另检查 deviceKey。本专项始终使用原 Agent 身份，因此不把结果扩大为“同名设备重装后旧图片预览”的身份隔离验证。
