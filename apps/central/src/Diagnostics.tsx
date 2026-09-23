// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from 'react';
import { nativeAvailable } from './native';
import { RuntimeUpdates } from './RuntimeUpdates';
import { createDiagnosticsSession, diagnosticsMessage, initialDiagnosticsState } from './diagnostics-client';

const serviceLabels = { stopped: '已停止', starting: '正在启动', running: '正在运行', stopping: '正在停止', failed: '运行失败' };
const timeLabel = (time: number) => new Date(time).toLocaleString('zh-CN', { hour12: false });
export function Diagnostics({ onConfigure }: { onConfigure: () => void }) {
  const [state, setState] = useState(initialDiagnosticsState);
  const session = useRef<ReturnType<typeof createDiagnosticsSession> | null>(null);
  useEffect(() => {
    if (!nativeAvailable) return;
    const owned = createDiagnosticsSession({ update: setState }); session.current = owned; owned.refresh();
    return () => { owned.dispose(); if (session.current === owned) session.current = null; };
  }, []);
  const report = state.report, config = report?.configuration, service = report?.service;
  return <div className="diagnostics">
    <RuntimeUpdates />
    <section className="card inspection-panel">
      <div className="section-title"><h2>本机诊断报告</h2><div className="button-row">
        <button className="button secondary" disabled={!nativeAvailable || state.readPending} onClick={() => session.current?.refresh()}>{state.readPending ? '等待读取结束' : '刷新报告'}</button>
        <button className="button primary" disabled={!nativeAvailable || state.exportPending} onClick={() => session.current?.export()}>{state.exportPending ? '等待保存结果' : '导出诊断 JSON'}</button>
      </div></div>
      <p className="section-description">报告记录采集时点的本机配置摘要和本次应用会话内的受管服务快照。此页面不会自动刷新，也不包含完整运行日志。</p>
      <p className="field-hint">导出时会重新采集报告，并由本机保存窗口选择位置，因此导出内容的采集时间可能与预览不同。</p>
      {!nativeAvailable && <p className="management-error" role="status">浏览器预览无法读取或导出本机诊断，请在中央管理 App 中打开此页。</p>}
      {state.readError && <p className="management-error" role="alert">{state.readError}</p>}
      {state.exportMessage && <p className={state.exportStatus === 'saved' ? 'management-success' : state.exportStatus === 'failed' || state.exportStatus === 'timeout' ? 'management-error' : 'diagnostics-notice'} role="status">{state.exportMessage}</p>}
      <p className="diagnostics-timestamp" role="status">{state.reading ? '正在采集本机诊断…' : report ? `报告采集于 ${timeLabel(report.generatedAt)} · 后续状态可能已变化，查看新状态请刷新报告。` : '尚无诊断报告。请刷新报告后查看本机状态。'}</p>
      {report && <div className="inspection-config"><span>应用版本 {report.appVersion}</span><span>系统 {report.platform === 'windows' ? 'Windows' : report.platform === 'macos' ? 'macOS' : '其他系统'}</span><span>报告格式 v{report.schemaVersion}</span></div>}
    </section>

    <div className="diagnostics-grid">
      <section className="card inspection-panel"><div className="section-title"><h2>服务故障与恢复</h2>{service && <span className={`badge ${service.failureCode || service.forcedStop ? 'warning' : ''}`}>{serviceLabels[service.state]}</span>}</div>
        {!service ? <p className="section-description">采集报告后，可查看受管服务状态与恢复建议。</p> : <>
          <p className="section-description">以下内容来自 {timeLabel(service.observedAt)} 的服务快照。</p>
          {service.failureCode ? <div className="management-error"><strong>{service.failureCode}</strong><p>{diagnosticsMessage(service.failureCode)}</p></div>
            : <p className="diagnostics-notice">当前快照未记录服务故障。其他操作错误和更早的会话记录不在此报告内。</p>}
          <dl className="diagnostics-values"><div><dt>进程清理</dt><dd>{service.cleanupVerified ? '已确认' : service.state === 'running' || service.state === 'starting' ? '服务活动中，尚未执行退出清理' : '尚未确认，请核对服务状态'}</dd></div>
            <div><dt>强制退出</dt><dd>{service.forcedStop ? '本次服务记录了强制退出' : '当前快照未记录'}</dd></div>
            <div><dt>运行统计</dt><dd>{service.metricsStatus === 'fresh' ? '采集时有效' : service.metricsStatus === 'stale' ? '采集时已过期，数量未确认' : service.metricsStatus === 'missing' ? '采集时尚未收到统计' : '服务未运行，未采集数量'}</dd></div>
          </dl>
          {service.metrics && <p className="field-hint">采集时在线设备 {service.metrics.onlineDevices} · 运行任务 {service.metrics.activeTurns} · 模型进程 {service.metrics.workers}</p>}
          {service.forcedStop && <p className="field-hint">发生过强制退出，请确认清理状态后再启动服务。</p>}
        </>}
      </section>
      <section className="card inspection-panel"><div className="section-title"><h2>已保存的设置</h2><button className="text-button" onClick={onConfigure}>编辑本机配置</button></div>
        <p className="section-description">这里显示已保存的配置。运行中的服务可能仍使用启动时的设置；修改并保存后，下次启动服务时应用。</p>
        {!config ? <p className="diagnostics-notice">尚未取得配置摘要。</p> : config.status === 'missing' ? <p className="diagnostics-notice">尚未保存本机配置。请打开本机配置完成设置。</p>
          : config.status === 'unavailable' ? <p className="management-error">{diagnosticsMessage(config.errorCode)}</p>
            : <dl className="diagnostics-values">
              <div><dt>配置版本</dt><dd>{config.revision}</dd></div>
              <div><dt>模型进程上限</dt><dd>{config.limits?.maxWorkers}</dd></div><div><dt>每用户并发任务</dt><dd>{config.limits?.perUserTurns}</dd></div><div><dt>总并发任务</dt><dd>{config.limits?.totalTurns}</dd></div>
              <div><dt>正常退出等待</dt><dd>{config.shutdown?.graceMs} 毫秒</dd></div><div><dt>强制退出等待</dt><dd>{config.shutdown?.forceMs} 毫秒</dd></div>
              <div><dt>运行包</dt><dd>{config.runtimeSelected ? '已选择' : '未选择'}</dd></div><div><dt>服务证书</dt><dd>{config.certificateSelected ? '已选择' : '未选择'}</dd></div>
            </dl>}
      </section>
    </div>
    {report && <details className="card diagnostics-preview"><summary>查看完整诊断 JSON 预览</summary><p className="section-description">仅包含下方公开字段；账号凭据、文件内容和完整本机路径不包含在报告内。</p><pre tabIndex={0} aria-label="诊断 JSON 预览">{JSON.stringify(report, null, 2)}</pre></details>}
  </div>;
}
