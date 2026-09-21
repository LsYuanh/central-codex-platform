// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from 'react';
import { UiIcon } from '../../desktop/src/UiIcon';
import { nativeAvailable } from './native';
import { getMetricsSnapshot } from './service-client';
import { metricsView, startMetricsPolling, type MetricsState } from './overview-metrics';

export function OverviewMetrics({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<MetricsState>(() => ({ snapshot: null, checkedAt: null, waitingSince: Date.now(), loading: true, pending: false, error: '', now: Date.now() }));
  const poller = useRef<ReturnType<typeof startMetricsPolling> | null>(null);
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (!nativeAvailable) return;
    const owned = startMetricsPolling({ read: getMetricsSnapshot, update: setState, visible: () => !document.hidden });
    poller.current = owned;
    const visibility = () => owned.visibilityChanged();
    document.addEventListener('visibilitychange', visibility);
    return () => { owned.dispose(); document.removeEventListener('visibilitychange', visibility); if (poller.current === owned) poller.current = null; };
  }, []);
  useEffect(() => { if (refreshKey !== lastRefreshKey.current) { lastRefreshKey.current = refreshKey; poller.current?.refresh(); } }, [refreshKey]);
  const view = nativeAvailable ? metricsView(state) : { numbers: null, message: '浏览器预览无法读取运行统计，请在中央管理 App 中查看。', retry: false, metrics: null };
  const cards = [
    { label: '在线设备', icon: 'monitor' as const, detail: '已连接的 Local Agent 设备' },
    { label: '运行任务', icon: 'activity' as const, detail: '当前正在运行的模型任务' },
    { label: '模型运行进程', icon: 'build' as const, detail: '已启动且未停止的用户 Worker' },
  ];
  return <section className="overview-metrics" aria-label="运行统计">
    <div className="metrics">{cards.map((card, index) => <section className="metric card" key={card.label}>
      <div><span>{card.label}</span><UiIcon name={card.icon} /></div>
      <strong aria-label={`${card.label}${view.numbers ? view.numbers[index] : '未知'}`}>{view.numbers ? view.numbers[index] : '—'}</strong>
      <small>{card.detail}</small>
      {index === 2 && view.metrics && <small className="metric-worker-detail">就绪 {view.metrics.readyWorkers} · 启动中 {view.metrics.startingWorkers} · 停止中 {view.metrics.stoppingWorkers}</small>}
    </section>)}</div>
    <div className="overview-metrics-status"><span role="status">{view.message}</span>{view.retry && <button className="text-button" disabled={state.pending} onClick={() => poller.current?.refresh()}>{state.pending ? '等待读取结束' : '刷新统计'}</button>}</div>
  </section>;
}
