import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "~/lib/account";
import { invoke } from "~/lib/api";
import { useHubInfo } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";
import { AccountSunrise } from "./AccountSunrise";

const copy = {
  en: { title: "Tomrade account", intro: "Your account synchronizes the Hub catalog and preferences. Project content stays in your project folders.", email: "Email", password: "Password", signIn: "Sign in", signUp: "Create account", signOut: "Sign out", sync: "Sync Hub", busy: "Working…", confirmation: "Check your email to confirm your account, then sign in here.", pending: "Pending changes", local: "Keep local", cloud: "Use cloud", conflict: "Choose which version of this Hub record to keep", loading: "Loading account…", retry: "Retry" },
  zh: { title: "Tomrade 账号", intro: "账号同步 Hub 目录和用户偏好。项目内容仍保存在各自的项目文件夹中。", email: "邮箱", password: "密码", signIn: "登录", signUp: "注册账号", signOut: "退出登录", sync: "同步 Hub", busy: "处理中…", confirmation: "请查收邮件并确认账号，然后回到这里登录。", pending: "待同步变更", local: "保留本地版本", cloud: "使用云端版本", conflict: "请选择要保留的 Hub 记录版本", loading: "正在读取账号…", retry: "重试" }
};

export function AccountPanel() {
  const { locale } = useI18n();
  const t = copy[locale];
  const account = useAccount();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setNotice("");
    try { await action(); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally {
      setPassword(""); setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["account"] }), qc.invalidateQueries({ queryKey: ["settings"] }), qc.invalidateQueries({ queryKey: ["storage", "hub"] })]);
    }
  };
  return <div className="panel stack-3" aria-busy={busy}>
    <h2 className="sec-title">{t.title}</h2>
    <p className="meta-txt">{t.intro}</p>
    {account.isPending ? <p>{t.loading}</p> : account.error ? <>
      <p role="alert">{account.error.message}</p><button className="btn btn-secondary" onClick={() => void account.refetch()}>{t.retry}</button>
    </> : account.data?.user ? <>
      <p>{account.data.user.email}</p>
      <p className="meta-txt">{t.pending}: {account.data.pending}</p>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => invoke("account.sync"))}>{busy ? t.busy : t.sync}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t.signOut}</button>
      </div>
      {account.data.conflicts.map(c => <div key={c.id} className="panel stack-3">
        <p>{t.conflict}: {c.id}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.local}: {JSON.stringify(c.local, null, 2)}{"\n"}{t.cloud}: {JSON.stringify(c.cloud, null, 2)}</pre>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => invoke("account.resolve", c.id, "local"))}>{t.local}</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => invoke("account.resolve", c.id, "cloud"))}>{t.cloud}</button>
        </div>
      </div>)}
    </> : <form className="stack-3" onSubmit={e => { e.preventDefault(); void run(() => invoke("account.signIn", email.trim(), password)); }}>
      <label className="field">{t.email}<input className="input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label className="field">{t.password}<input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy || !email || !password}>{busy ? t.busy : t.signIn}</button>
        <button className="btn btn-secondary" type="button" disabled={busy || !email || password.length < 8} onClick={() => void run(async () => {
          const result = await invoke("account.signUp", email.trim(), password);
          if (result.confirmationRequired) setNotice(t.confirmation);
        })}>{t.signUp}</button>
      </div>
    </form>}
    {!account.data?.user && account.data?.offlineAccess && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t.signOut}</button>}
    {account.data?.status.detail && <p role="status">{account.data.status.detail}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

export function AccountGate({ children }: { children: ReactNode }) {
  const hub = useHubInfo();
  const account = useAccount();
  if (hub.isPending) return null;
  if (hub.data?.cloudEnabled && !account.data?.user && !account.data?.offlineAccess) return <main className="sheet account-gate">
    <AccountSunrise />
    <div className="account-gate__content">
      <header className="account-gate__brand">
        <h1>TOMRADE</h1>
        <p>一起，向前 <span aria-hidden="true">✦</span> FORWARD, TOGETHER</p>
      </header>
      <div className="account-gate__form"><AccountPanel /></div>
    </div>
  </main>;
  return children;
}
