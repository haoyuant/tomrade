import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "~/lib/account";
import { invoke, messageOf } from "~/lib/api";
import { useHubInfo } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";
import { AccountSunrise } from "./AccountSunrise";

const MIN_PASSWORD = 8;

const copy = {
  en: {
    title: "Tomrade account", intro: "Your account synchronizes the Hub catalog and preferences. Project content stays in your project folders.", email: "Email", password: "Password", signIn: "Sign in", signUp: "Create account", signOut: "Sign out", sync: "Sync Hub", busy: "Working…", confirmation: "Check your email to confirm your account, then sign in here.", pending: "Pending changes", local: "Keep local", cloud: "Use cloud", conflict: "Choose which version of this Hub record to keep", loading: "Loading account…", retry: "Retry",
    passwordHint: `A new account needs at least ${MIN_PASSWORD} characters.`,
    needEmail: "Enter your email.", badEmail: "That doesn't look like an email address.", needPassword: "Enter your password.", shortPassword: `Use at least ${MIN_PASSWORD} characters for a new account.`,
    otherAccount: (owner: string) => `Another account opens its own projects. ${owner}'s projects stay on this computer for when you sign back in.`,
    switching: (email: string) => `Opening ${email}'s projects…`,
    errors: {
      invalid_credentials: "Wrong email or password.",
      email_not_confirmed: "Confirm your email first: open the link we sent you, then sign in.",
      user_already_exists: "An account with this email already exists. Sign in instead.",
      email_exists: "An account with this email already exists. Sign in instead.",
      weak_password: `That password is too weak. Use at least ${MIN_PASSWORD} characters.`,
      email_address_invalid: "Enter a valid email address.",
      over_request_rate_limit: "Too many attempts. Wait a minute, then try again.",
      over_email_send_rate_limit: "Too many emails sent. Wait a few minutes, then try again.",
      signup_disabled: "New accounts can't be created right now.",
      network: "Can't reach the Tomrade server. Check your connection, then try again.",
      other_account: "This computer's projects belong to another account. Sign in with that account."
    } as Record<string, string>
  },
  zh: {
    title: "Tomrade 账号", intro: "账号同步 Hub 目录和用户偏好。项目内容仍保存在各自的项目文件夹中。", email: "邮箱", password: "密码", signIn: "登录", signUp: "注册账号", signOut: "退出登录", sync: "同步 Hub", busy: "处理中…", confirmation: "请查收邮件并确认账号，然后回到这里登录。", pending: "待同步变更", local: "保留本地版本", cloud: "使用云端版本", conflict: "请选择要保留的 Hub 记录版本", loading: "正在读取账号…", retry: "重试",
    passwordHint: `注册新账号需要至少 ${MIN_PASSWORD} 位密码。`,
    needEmail: "请输入邮箱。", badEmail: "邮箱格式不正确。", needPassword: "请输入密码。", shortPassword: `注册新账号的密码至少需要 ${MIN_PASSWORD} 位。`,
    otherAccount: (owner: string) => `换用其他账号会打开那个账号自己的项目；${owner} 的项目仍保留在这台电脑上，重新登录即可回来。`,
    switching: (email: string) => `正在打开 ${email} 的项目…`,
    errors: {
      invalid_credentials: "邮箱或密码不正确。",
      email_not_confirmed: "请先确认邮箱：打开我们发给你的确认链接，然后再登录。",
      user_already_exists: "这个邮箱已经注册过了，请直接登录。",
      email_exists: "这个邮箱已经注册过了，请直接登录。",
      weak_password: `密码太弱，请至少使用 ${MIN_PASSWORD} 位。`,
      email_address_invalid: "请输入有效的邮箱地址。",
      over_request_rate_limit: "尝试次数过多，请稍等一分钟再试。",
      over_email_send_rate_limit: "发送邮件过于频繁，请过几分钟再试。",
      signup_disabled: "目前暂不开放注册新账号。",
      network: "无法连接 Tomrade 服务器，请检查网络后重试。",
      other_account: "这台电脑上的项目属于另一个账号，请使用那个账号登录。"
    } as Record<string, string>
  }
};

type Problem = { field: "email" | "password"; text: string };

export function AccountPanel({ entrance = false }: { entrance?: boolean }) {
  const { locale } = useI18n();
  const t = copy[locale];
  const account = useAccount();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const owner = account.data?.user ? null : account.data?.owner?.email ?? null;
  const switchingTo = account.data?.switchingTo ?? null;
  // Whoever signed out here is the likeliest to sign back in.
  const prefilled = useRef(false);
  useEffect(() => {
    if (owner && !prefilled.current) { prefilled.current = true; setEmail(e => e || owner); }
  }, [owner]);
  // Failures from the main process lead with a [code] this panel can say in the reader's language.
  const explain = (e: unknown) => {
    const text = messageOf(e);
    const code = /^\[(\w+)\] /.exec(text);
    return code ? t.errors[code[1]] ?? text.slice(code[0].length) : text;
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setNotice("");
    try { await action(); }
    catch (e) { setNotice(explain(e)); }
    finally {
      setPassword(""); setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["account"] }), qc.invalidateQueries({ queryKey: ["settings"] }), qc.invalidateQueries({ queryKey: ["storage", "hub"] })]);
    }
  };
  // Buttons stay pressable; pressing one says what is missing, beside the field it concerns.
  function check(creating: boolean): boolean {
    const address = email.trim();
    const found: Problem | null = !address ? { field: "email", text: t.needEmail }
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? { field: "email", text: t.badEmail }
      : !password ? { field: "password", text: t.needPassword }
      : creating && password.length < MIN_PASSWORD ? { field: "password", text: t.shortPassword }
      : null;
    setProblem(found);
    setNotice("");
    if (found) (found.field === "email" ? emailRef : passwordRef).current?.focus();
    return !found;
  }
  return <div className="panel stack-3" aria-busy={busy || switchingTo !== null}>
    {!entrance && <>
      <h2 className="sec-title">{t.title}</h2>
      <p className="meta-txt">{t.intro}</p>
    </>}
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
    </> : switchingTo !== null ? <p role="status">{t.switching(switchingTo)}</p> : <form className="stack-3" noValidate onSubmit={e => {
      e.preventDefault();
      if (check(false)) void run(() => invoke("account.signIn", email.trim(), password));
    }}>
      <div className="field-group">
        <label className="field">{t.email}<input ref={emailRef} className="input" type="email" autoComplete="username" value={email}
          aria-invalid={problem?.field === "email" || undefined} aria-describedby={problem?.field === "email" ? "account-problem" : undefined}
          onChange={e => { setEmail(e.target.value); setProblem(null); }} /></label>
        {problem?.field === "email" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
      </div>
      <div className="field-group">
        <label className="field">{t.password}<input ref={passwordRef} className="input" type="password" autoComplete="current-password" value={password}
          aria-invalid={problem?.field === "password" || undefined} aria-describedby={problem?.field === "password" ? "account-problem" : "account-password-hint"}
          onChange={e => { setPassword(e.target.value); setProblem(null); }} /></label>
        {problem?.field === "password"
          ? <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>
          : <span id="account-password-hint" className="field-note">{t.passwordHint}</span>}
      </div>
      {owner && email.trim() && email.trim().toLowerCase() !== owner.toLowerCase() && <p className="field-note">{t.otherAccount(owner)}</p>}
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? t.busy : t.signIn}</button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {
          if (check(true)) void run(async () => {
            const result = await invoke("account.signUp", email.trim(), password);
            if (result.confirmationRequired) setNotice(t.confirmation);
          });
        }}>{t.signUp}</button>
      </div>
    </form>}
    {!account.data?.user && account.data?.offlineAccess && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t.signOut}</button>}
    {account.data?.status.detail && !(entrance && account.data.status.state === "unavailable") && <p role="status">{account.data.status.detail}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

export function AccountGate({ children }: { children: ReactNode }) {
  const hub = useHubInfo();
  const account = useAccount();
  const [entered, setEntered] = useState(false);
  if (hub.isPending) return null;
  if (hub.data?.cloudEnabled && !account.data?.user && !account.data?.offlineAccess) return <main className="sheet account-gate">
    <AccountSunrise />
    <div className="account-gate__content">
      <header className="account-gate__brand">
        <h1>TOMRADE</h1>
        <p>一起，向前 <span aria-hidden="true">✦</span> FORWARD, TOGETHER</p>
      </header>
      <div className={entered ? "account-gate__form is-entered" : "account-gate__form"} onFocus={() => setEntered(true)}
        onAnimationEnd={e => { if (e.target === e.currentTarget) setEntered(true); }}><AccountPanel entrance /></div>
    </div>
  </main>;
  return children;
}
