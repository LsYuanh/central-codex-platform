// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { ServiceMetrics, ServiceSnapshot } from './service-client';

export const METRICS_MAX_AGE = 10000;
export type MetricsState = {
  snapshot: ServiceSnapshot | null; checkedAt: number | null; waitingSince: number;
  loading: boolean; pending: boolean; error: string; now: number;
};
export function acceptMetricsSnapshot(previous: ServiceSnapshot | null, incoming: ServiceSnapshot) {
  if (previous && (incoming.generation < previous.generation || (incoming.generation === previous.generation &&
      (incoming.sequence < previous.sequence || incoming.instanceId !== previous.instanceId)))) throw { code: 'UI_PROTOCOL_INVALID' };
  if (previous && incoming.generation === previous.generation && previous.metrics && incoming.metrics) {
    if (incoming.metrics.sequence < previous.metrics.sequence || incoming.metrics.observedAt < previous.metrics.observedAt ||
        (incoming.metrics.sequence === previous.metrics.sequence && JSON.stringify(incoming.metrics) !== JSON.stringify(previous.metrics))) throw { code: 'UI_PROTOCOL_INVALID' };
  }
  return incoming;
}
export function metricsView(state: MetricsState): { numbers: [number, number, number] | null; message: string; retry: boolean; metrics: ServiceMetrics | null } {
  const hidden = (message: string, retry = false) => ({ numbers: null, message, retry, metrics: null });
  if (state.error) return hidden(state.error, true);
  if (state.loading) return hidden('正在读取运行统计…');
  const snapshot = state.snapshot;
  if (!snapshot || state.checkedAt === null) return hidden('尚未取得运行统计。', true);
  if (state.now < state.checkedAt || state.now - state.checkedAt > METRICS_MAX_AGE) return hidden('运行统计已过期，请刷新。', true);
  if (snapshot.state === 'stopped' && snapshot.cleanupVerified) return { numbers: [0, 0, 0], message: '服务已停止，进程清理已确认。', retry: false, metrics: null };
  if (snapshot.state === 'failed') return hidden('服务运行失败，当前数量未确认。请检查服务状态。', true);
  if (snapshot.state === 'stopped') return hidden('进程清理尚未确认，当前数量未知。', true);
  if (snapshot.state === 'starting') return hidden('服务正在启动，运行统计尚未就绪。');
  if (snapshot.state === 'stopping') return hidden('服务正在停止，等待确认进程清理。');
  const metrics = snapshot.metrics;
  if (!metrics) return state.now - state.waitingSince >= METRICS_MAX_AGE
    ? hidden('未收到运行统计，请重试并检查运行包是否支持统计。', true)
    : hidden('服务已运行，等待首份运行统计…');
  if (state.now < metrics.observedAt || state.now - metrics.observedAt > METRICS_MAX_AGE) return hidden('运行统计已过期或时间异常，请刷新。', true);
  return { numbers: [metrics.onlineDevices, metrics.activeTurns, metrics.workers],
    message: '统计每 2 秒更新 · 来自本机中央服务', retry: false, metrics };
}

type PollingOptions = {
  read: () => Promise<ServiceSnapshot>; update: (state: MetricsState) => void;
  visible: () => boolean; now?: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
};
// A UI timeout changes display state, but retains the in-flight lock until the
// actual IPC settles. Hidden/unmounted epochs cannot publish a late response.
export function startMetricsPolling(options: PollingOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  let active = true, inFlight = false, epoch = 0, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let state: MetricsState = { snapshot: null, checkedAt: null, waitingSince: now(), loading: true, pending: false, error: '', now: now() };
  const publish = () => { if (active && options.visible()) options.update({ ...state, now: now() }); };
  const refresh = () => {
    if (!active || !options.visible()) return;
    if (inFlight) { queued = true; return; }
    inFlight = true; queued = false;
    const requestEpoch = epoch;
    let timedOut = false;
    state = { ...state, pending: true }; publish();
    deadline = setTimer(() => {
      timedOut = true;
      if (!active) return;
      state = { ...state, loading: false, error: '读取运行统计超时。当前请求尚未结束，请稍后刷新。' }; publish();
    }, 8000);
    void Promise.resolve().then(options.read).then(incoming => {
      if (!active || requestEpoch !== epoch || timedOut) return;
      const snapshot = acceptMetricsSnapshot(state.snapshot, incoming);
      const changed = !state.snapshot || snapshot.generation !== state.snapshot.generation || snapshot.instanceId !== state.snapshot.instanceId || snapshot.state !== state.snapshot.state;
      state = { ...state, snapshot, checkedAt: now(), waitingSince: changed ? now() : state.waitingSince, loading: false, error: '' };
      publish();
    }).catch(() => {
      if (!active || requestEpoch !== epoch || timedOut) return;
      state = { ...state, loading: false, error: '无法读取运行统计，请刷新重试。' }; publish();
    }).finally(() => {
      clearTimer(deadline); deadline = undefined; inFlight = false;
      if (!active) return;
      state = { ...state, pending: false }; publish();
      if (queued || requestEpoch !== epoch) refresh();
    });
  };
  const tick = () => {
    if (!active) return;
    if (options.visible()) { publish(); refresh(); }
    timer = setTimer(tick, 2000);
  };
  refresh(); timer = setTimer(tick, 2000);
  return {
    refresh,
    visibilityChanged() {
      epoch++; queued = false;
      // Do not flash the previous instance's numbers on returning to the page.
      if (options.visible()) { state = { ...state, loading: !inFlight || !state.error, error: inFlight ? state.error : '' }; publish(); refresh(); }
    },
    dispose() { active = false; epoch++; clearTimer(timer); clearTimer(deadline); },
  };
}
