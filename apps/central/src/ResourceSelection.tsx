// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from "react";
import { nativeCall } from "./native";

type Package = { id: string; label: string; platform: string; architecture: string; qualified: false };
type PackageReport = { packageId: string; status: string; ready: false; files: { name: string; status: string }[]; blockers: string[] };
type Certificate = { certificateId: string; clientUrl: string; leafFingerprintSha256: string; leafExpiresAt: number; privateKeyPersisted: true; runtimeReady: false };
type CertificateEntry = { certificateId: string; report: Certificate | null; failure: { code: string } | null };
const errors: Record<string, string> = {
  TLS_FILES_MISSING: "目录中缺少 server.pem、server-key.pem 或 ca.pem。",
  TLS_FILES_UNSAFE: "证书文件无法安全读取，请使用普通本机文件。",
  TLS_FORMAT_INVALID: "证书格式不正确。服务器私钥需为未加密 PKCS#8 PEM。",
  TLS_PRIVATE_KEY_MISMATCH: "私钥与服务器证书不匹配。",
  TLS_CHAIN_INVALID: "证书链或服务器用途校验失败，请检查 CA 和中间证书。",
  TLS_CERTIFICATE_TIME_INVALID: "证书已过期或尚未生效，请检查证书及本机时间。",
  TLS_HOSTNAME_MISMATCH: "证书未包含当前客户端连接地址的主机名或 IP。",
  TLS_STORAGE_UNSAFE: "加密证书存储不可用，请检查目录和权限。",
  TLS_PLATFORM_UNSUPPORTED: "当前系统暂不支持原生证书导入。",
  TLS_EXPORT_FAILED: "公共 CA 导出失败，请选择可写位置和一个新文件名。",
  CONFIG_INVALID: "客户端连接地址不正确，请返回第二步检查。",
  OPERATION_BUSY: "另一资源操作尚未结束，请先完成或取消已打开的选择窗口。",
  OPERATION_TIMEOUT: "暂未确认结果。请先关闭未完成的选择窗口，再刷新列表核对是否已导入。",
};
function message(cause: unknown): string {
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  return errors[code] ?? "资源操作失败，请刷新后重试。";
}
const packageStates: Record<string, string> = {
  verified: "完整候选包核验通过，可用于开发版验证服务",
  "candidate-incomplete": "文件核验通过，完整运行包尚未就绪",
  missing: "运行包文件尚未放入应用资源目录",
  invalid: "文件或哈希不符合内置清单",
  unsupported: "此运行包不支持当前系统或架构",
  unknown: "此运行包不在内置清单中",
};

export function ResourceSelection({ clientUrl, certificateId, packageId, onCertificate, onPackage, onBusy }: {
  clientUrl: string; certificateId: string; packageId: string; onCertificate: (id: string) => void; onPackage: (id: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [packages, setPackages] = useState<Package[]>([]);
  const [certificates, setCertificates] = useState<CertificateEntry[]>([]);
  const [report, setReport] = useState<PackageReport | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const current = useRef({ clientUrl, packageId });
  current.current = { clientUrl, packageId };
  const serial = useRef(0);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => { onBusy(!!busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function refresh() {
    if (lock.current) return;
    lock.current = true; setBusy("refresh"); setError(""); setNotice(""); setLoaded(false);
    const epoch = ++serial.current;
    const url = clientUrl;
    try {
      const [catalogResult, entriesResult] = await Promise.allSettled([
        nativeCall<Package[]>("central_runtime_catalog"),
        nativeCall<CertificateEntry[]>("central_tls_list", 20000, { clientUrl: url }),
      ]);
      if (catalogResult.status === "rejected") throw catalogResult.reason;
      const catalog = catalogResult.value;
      if (!Array.isArray(catalog) || catalog.some(p => typeof p.id !== "string" || p.qualified !== false)) throw new Error("invalid catalog response");
      if (mounted.current && epoch === serial.current) setPackages(catalog);
      if (entriesResult.status === "rejected") throw entriesResult.reason;
      const entries = entriesResult.value;
      if (!Array.isArray(entries) ||
        entries.some(c => typeof c.certificateId !== "string" || (c.report && (c.report.runtimeReady !== false || c.report.privateKeyPersisted !== true || c.report.clientUrl !== url)))) throw new Error("invalid resource response");
      if (mounted.current && epoch === serial.current && current.current.clientUrl === url) {
        setCertificates(entries); setLoaded(true);
      }
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  useEffect(() => { setCertificates([]); setLoaded(false); void refresh(); }, [clientUrl]); // Native results are tied to this URL.
  async function inspectPackage() {
    if (lock.current || !packageId) return;
    lock.current = true; setBusy("package"); setError(""); setReport(null);
    const id = packageId;
    try {
      const result = await nativeCall<PackageReport>("central_package_inspect", 60000, { packageId: id });
      if (result.packageId !== id || result.ready !== false || !Array.isArray(result.files)) throw new Error("invalid package response");
      if (mounted.current && current.current.packageId === id) setReport(result);
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function importCertificate() {
    if (lock.current) return;
    lock.current = true; setBusy("import"); setError(""); setNotice("");
    const url = clientUrl;
    try {
      const result = await nativeCall<Certificate | null>("central_tls_import", 120000, { clientUrl: url });
      if (result && (result.runtimeReady !== false || result.privateKeyPersisted !== true || result.clientUrl !== url || typeof result.certificateId !== "string")) throw new Error("invalid certificate response");
      if (mounted.current && current.current.clientUrl === url) {
        if (result) {
          setCertificates(previous => [...previous.filter(entry => entry.certificateId !== result.certificateId), { certificateId: result.certificateId, report: result, failure: null }]);
          onCertificate(result.certificateId); setNotice("证书已校验并加密导入。请保存本机配置以使用此证书。");
        } else setNotice("已取消导入。");
      }
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function exportCa() {
    if (lock.current || !certificateId) return;
    lock.current = true; setBusy("export"); setError(""); setNotice("");
    try {
      const saved = await nativeCall<boolean>("central_tls_export_ca", 120000, { certificateId });
      if (typeof saved !== "boolean") throw new Error("invalid export response");
      if (mounted.current) setNotice(saved ? "公共 CA 已导出。" : "已取消导出。");
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  const selected = certificates.find(c => c.certificateId === certificateId);
  return <div className="resource-selection" aria-busy={!!busy}>
    <div className="section-title"><h3>运行资源</h3><button className="button secondary" disabled={!!busy} onClick={() => void refresh()}>{busy === "refresh" ? "正在刷新…" : "刷新资源列表"}</button></div>
    <label className="native-field">运行包<select value={packageId} disabled={!!busy} onChange={event => { onPackage(event.target.value); setReport(null); }}>
      <option value="">选择内置清单中的候选包</option>
      {packageId && !packages.some(p => p.id === packageId) && <option value={packageId}>{packageId}（未在清单中）</option>}
      {packages.map(p => <option key={p.id} value={p.id}>{p.label} · {p.architecture}</option>)}
    </select></label>
    <p className="field-hint">请选择完整服务候选包。核验通过后可在开发版中启动验证服务，正式发布验收仍待完成。</p>
    <button className="button secondary" disabled={!!busy || !packageId} onClick={() => void inspectPackage()}>{busy === "package" ? "正在计算文件哈希…" : "核验运行包文件"}</button>
    {report && report.packageId === packageId && <div className="resource-result" role="status"><strong>{packageStates[report.status] ?? "运行包未就绪"}</strong><p>已核验 {report.files.length} 个文件，{report.files.filter(file => file.status === "passed").length} 个通过。</p><details><summary>查看文件校验明细</summary><ul className="package-file-results">{report.files.map(file => <li key={file.name}><span>{file.name}</span><span className={file.status === "passed" ? "check-state passed" : "check-state failed"}>{file.status === "passed" ? "哈希通过" : file.status === "missing" ? "缺少文件" : "校验失败"}</span></li>)}</ul></details></div>}
    <label className="native-field">服务器证书<select value={certificateId} disabled={!!busy || !loaded} onChange={event => onCertificate(event.target.value)}>
      <option value="">{loaded && certificates.length === 0 ? "尚无已导入证书" : "选择已导入证书"}</option>
      {certificateId && !selected && <option value={certificateId}>{certificateId}（未找到）</option>}
      {certificates.map(c => <option key={c.certificateId} value={c.certificateId}>{c.report ? `${c.report.leafFingerprintSha256.slice(0, 16)}… · 有效至 ${new Date(c.report.leafExpiresAt).toLocaleDateString("zh-CN")}` : `${c.certificateId}（校验失败）`}</option>)}
    </select></label>
    <p className="field-hint">选择包含 server.pem、server-key.pem 和 ca.pem 的目录。私钥由本机加密保存；每次刷新按当前客户端地址重新校验。</p>
    <div className="button-row"><button className="button secondary" disabled={!!busy || !clientUrl} onClick={() => void importCertificate()}>{busy === "import" ? "选择并导入中…" : "导入服务器证书"}</button><button className="button secondary" disabled={!!busy || !selected?.report} onClick={() => void exportCa()}>{busy === "export" ? "选择导出位置…" : "导出公共 CA"}</button></div>
    {selected?.report && <div className="resource-result"><strong>证书校验通过 · 私钥已加密保存</strong><p>SHA-256：{selected.report.leafFingerprintSha256}</p><p>校验地址：{selected.report.clientUrl}</p><p>吊销状态未检查；服务状态请查看运行概览。</p></div>}
    {selected?.failure && <p className="field-error" role="alert">{message(selected.failure)}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {notice && <p className="management-success" role="status">{notice}</p>}
  </div>;
}
