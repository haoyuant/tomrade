import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "~/lib/account";
import { invoke, messageOf } from "~/lib/api";
import { useHubInfo } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";
import { AccountSunrise } from "./AccountSunrise";

const MIN_PASSWORD = 8;
/** Supabase sends one address at most one email a minute. */
const MAIL_INTERVAL = 60;

const copy = {
  en: {
    title: "Tomrade account", intro: "Your account synchronizes the Hub catalog and preferences. Project content stays in your project folders.", email: "Email", password: "Password", signIn: "Sign in", signUp: "Create account", signOut: "Sign out", sync: "Sync Hub", busy: "Working…", pending: "Pending changes", local: "Keep local", cloud: "Use cloud", conflict: "Choose which version of this Hub record to keep", loading: "Loading account…", retry: "Retry",
    passwordHint: `A new account needs at least ${MIN_PASSWORD} characters.`,
    needEmail: "Enter your email.", badEmail: "That doesn't look like an email address.", needPassword: "Enter your password.", shortPassword: `Use at least ${MIN_PASSWORD} characters for a new account.`,
    otherAccount: (owner: string) => `Another account opens its own projects. ${owner}'s projects stay on this computer for when you sign back in.`,
    switching: (email: string) => `Opening ${email}'s projects…`,
    forgot: "Forgot password?",
    checkEmail: "Check your email",
    confirmSent: (email: ReactNode) => <>We sent a confirmation link to {email}.</>,
    confirmNext: "Open it to activate your account, then come back here. Tomrade signs you in by itself.",
    confirmed: "I've confirmed, sign in",
    notConfirmed: "This email isn't confirmed yet. Open the link we sent you, or send a new one.",
    stillNotConfirmed: "Not confirmed yet. Open the link in the email first, then press this again.",
    resend: "Resend email", resendIn: (n: number) => `Resend in ${n}s`,
    resent: "We sent a new link. Only the newest one works.",
    noMail: "Nothing there? Check your spam or junk folder, and that the address is right.",
    otherEmail: "Use a different email",
    resetTitle: "Reset your password",
    resetIntro: "Enter your account's email. We'll send you a link to choose a new password in your browser.",
    sendReset: "Send reset link",
    resetSent: (email: ReactNode) => <>If {email} has a Tomrade account, a reset link is on its way.</>,
    resetNext: "Choose a new password on the page the link opens, then come back here and sign in with it.",
    backToSignIn: "Back to sign in",
    mailWait: (n: number) => `We emailed this address less than a minute ago. Check your inbox, or try again in ${n}s.`,
    errors: {
      invalid_credentials: "Wrong email or password.",
      email_not_confirmed: "Confirm your email first: open the link we sent you, then sign in.",
      user_already_exists: "An account with this email already exists. Sign in, or choose “Forgot password?” if you don't remember it.",
      email_exists: "An account with this email already exists. Sign in, or choose “Forgot password?” if you don't remember it.",
      weak_password: `That password is too weak. Use at least ${MIN_PASSWORD} characters.`,
      email_address_invalid: "Enter a valid email address.",
      over_request_rate_limit: "Too many attempts. Wait a minute, then try again.",
      over_email_send_rate_limit: "Tomrade has sent too many emails for now. Try again later.",
      email_address_not_authorized: "Tomrade can't send email to this address yet. Try again later.",
      signup_disabled: "New accounts can't be created right now.",
      network: "Can't reach the Tomrade server. Check your connection, then try again.",
      other_account: "This computer's projects belong to another account. Sign in with that account."
    } as Record<string, string>
  },
  zh: {
    title: "Tomrade 账号", intro: "账号同步 Hub 目录和用户偏好。项目内容仍保存在各自的项目文件夹中。", email: "邮箱", password: "密码", signIn: "登录", signUp: "注册账号", signOut: "退出登录", sync: "同步 Hub", busy: "处理中…", pending: "待同步变更", local: "保留本地版本", cloud: "使用云端版本", conflict: "请选择要保留的 Hub 记录版本", loading: "正在读取账号…", retry: "重试",
    passwordHint: `注册新账号需要至少 ${MIN_PASSWORD} 位密码。`,
    needEmail: "请输入邮箱。", badEmail: "邮箱格式不正确。", needPassword: "请输入密码。", shortPassword: `注册新账号的密码至少需要 ${MIN_PASSWORD} 位。`,
    otherAccount: (owner: string) => `换用其他账号会打开那个账号自己的项目；${owner} 的项目仍保留在这台电脑上，重新登录即可回来。`,
    switching: (email: string) => `正在打开 ${email} 的项目…`,
    forgot: "忘记密码？",
    checkEmail: "请查收邮件",
    confirmSent: (email: ReactNode) => <>确认链接已发送到 {email}。</>,
    confirmNext: "打开链接激活账号，然后回到这里，Tomrade 会自动帮你登录。",
    confirmed: "我已确认，登录",
    notConfirmed: "这个邮箱还没有确认。请打开我们发给你的确认链接，或重新发送一封。",
    stillNotConfirmed: "还没有确认。请先打开邮件里的链接，再点一次这里。",
    resend: "重新发送", resendIn: (n: number) => `${n} 秒后可重新发送`,
    resent: "新的链接已发出，请使用最新那封邮件里的链接。",
    noMail: "没收到？看看垃圾邮件，并确认邮箱地址没有写错。",
    otherEmail: "换一个邮箱",
    resetTitle: "重设密码",
    resetIntro: "输入账号邮箱，我们会发一个链接，你可以在浏览器里设置新密码。",
    sendReset: "发送重设链接",
    resetSent: (email: ReactNode) => <>如果 {email} 注册过 Tomrade，重设链接已经发出。</>,
    resetNext: "在链接打开的网页上设置新密码，然后回到这里用新密码登录。",
    backToSignIn: "返回登录",
    mailWait: (n: number) => `刚刚已经给这个邮箱发过邮件了。请先查收，或 ${n} 秒后再试。`,
    errors: {
      invalid_credentials: "邮箱或密码不正确。",
      email_not_confirmed: "请先确认邮箱：打开我们发给你的确认链接，然后再登录。",
      user_already_exists: "这个邮箱已经注册过了，请直接登录；忘了密码可以点“忘记密码？”。",
      email_exists: "这个邮箱已经注册过了，请直接登录；忘了密码可以点“忘记密码？”。",
      weak_password: `密码太弱，请至少使用 ${MIN_PASSWORD} 位。`,
      email_address_invalid: "请输入有效的邮箱地址。",
      over_request_rate_limit: "尝试次数过多，请稍等一分钟再试。",
      over_email_send_rate_limit: "Tomrade 暂时发送的邮件过多，请稍后再试。",
      email_address_not_authorized: "暂时无法向这个邮箱发送邮件，请稍后再试。",
      signup_disabled: "目前暂不开放注册新账号。",
      network: "无法连接 Tomrade 服务器，请检查网络后重试。",
      other_account: "这台电脑上的项目属于另一个账号，请使用那个账号登录。"
    } as Record<string, string>
  }
};

type Problem = { field: "email" | "password"; text: string };
/** Signed out, the panel is the sign-in form, a wait for the confirmation email, or a password reset request. */
type Step = { kind: "form" } | { kind: "confirm"; email: string; password: string } | { kind: "reset"; sentTo: string | null };

// Failures from the main process lead with a [code] this panel can say in the reader's language.
const codeOf = (e: unknown) => /^\[(\w+)\] /.exec(messageOf(e))?.[1];
/** Seconds until this address may get another email, when that is why Supabase refused. */
const waitOf = (e: unknown) => codeOf(e) === "over_email_send_rate_limit" ? Number(/(\d+) seconds?/.exec(messageOf(e))?.[1]) || null : null;

function useCooldown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const stop = setTimeout(() => clearInterval(timer), until - Date.now() + 1000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [until]);
  return { left: Math.max(0, Math.ceil((until - now) / 1000)), start: (seconds: number) => { setNow(Date.now()); setUntil(Date.now() + seconds * 1000); } };
}

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
  const [step, setStep] = useState<Step>({ kind: "form" });
  const cooldown = useCooldown();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const Heading = entrance ? "h2" : "h3";
  const owner = account.data?.user ? null : account.data?.owner?.email ?? null;
  const switchingTo = account.data?.switchingTo ?? null;
  // Whoever signed out here is the likeliest to sign back in.
  const prefilled = useRef(false);
  useEffect(() => {
    if (owner && !prefilled.current) { prefilled.current = true; setEmail(e => e || owner); }
  }, [owner]);
  // A new step is announced by moving focus to its title.
  useEffect(() => { if (step.kind !== "form") stepTitle.current?.focus(); }, [step.kind, step.kind === "reset" && step.sentTo]);
  const explain = (e: unknown) => {
    const wait = waitOf(e);
    if (wait) return t.mailWait(wait);
    const text = messageOf(e);
    const code = codeOf(e);
    return code ? t.errors[code] ?? text.slice(code.length + 3) : text;
  };
  /** `quiet` keeps what the panel says and swallows failures: the retry when the window comes back. */
  const run = async (action: () => Promise<unknown>, quiet = false) => {
    setBusy(true);
    if (!quiet) setNotice("");
    try { await action(); }
    catch (e) {
      if (!quiet) {
        const wait = waitOf(e);
        if (wait) cooldown.start(wait);
        setNotice(explain(e));
      }
    }
    finally {
      setPassword(""); setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["account"] }), qc.invalidateQueries({ queryKey: ["settings"] }), qc.invalidateQueries({ queryKey: ["storage", "hub"] })]);
    }
  };
  const signIn = (address: string, secret: string, from: "form" | "confirm" | "return") => run(async () => {
    try {
      await invoke("account.signIn", address, secret);
      setStep({ kind: "form" });
    } catch (e) {
      if (codeOf(e) !== "email_not_confirmed") throw e;
      setStep({ kind: "confirm", email: address, password: secret });
      if (from !== "return") setNotice(from === "form" ? t.notConfirmed : t.stillNotConfirmed);
    }
  }, from === "return");
  const mail = (send: () => Promise<unknown>, then: () => void) => run(async () => { await send(); cooldown.start(MAIL_INTERVAL); then(); });
  const sendReset = (address: string) => mail(() => invoke("account.resetPassword", address, locale), () => setStep({ kind: "reset", sentTo: address }));
  const back = (field: "email" | "password") => {
    setStep({ kind: "form" }); setNotice(""); setProblem(null);
    requestAnimationFrame(() => (field === "email" ? emailRef : passwordRef).current?.focus());
  };
  // Coming back from the browser that opened the link signs in by itself.
  const onReturn = useRef<() => void>(undefined);
  onReturn.current = () => { if (step.kind === "confirm" && !busy) void signIn(step.email, step.password, "return"); };
  useEffect(() => {
    if (step.kind !== "confirm") return;
    let last = 0;
    const returned = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 5000) return;
      last = Date.now();
      onReturn.current?.();
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => { window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned); };
  }, [step.kind]);
  // Buttons stay pressable; pressing one says what is missing, beside the field it concerns.
  function check(mode: "signIn" | "signUp" | "reset"): boolean {
    const address = email.trim();
    const found: Problem | null = !address ? { field: "email", text: t.needEmail }
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? { field: "email", text: t.badEmail }
      : mode === "reset" ? null
      : !password ? { field: "password", text: t.needPassword }
      : mode === "signUp" && password.length < MIN_PASSWORD ? { field: "password", text: t.shortPassword }
      : null;
    setProblem(found);
    setNotice("");
    if (found) (found.field === "email" ? emailRef : passwordRef).current?.focus();
    return !found;
  }
  const emailField = <div className="field-group">
    <label className="field">{t.email}<input ref={emailRef} className="input" type="email" autoComplete="username" value={email}
      aria-invalid={problem?.field === "email" || undefined} aria-describedby={problem?.field === "email" ? "account-problem" : undefined}
      onChange={e => { setEmail(e.target.value); setProblem(null); }} /></label>
    {problem?.field === "email" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
  </div>;
  const resendLabel = cooldown.left ? t.resendIn(cooldown.left) : t.resend;
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
    </> : switchingTo !== null ? <p role="status">{t.switching(switchingTo)}</p> : step.kind === "confirm" ? <section className="account-step stack-3" aria-labelledby="account-step-title">
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t.checkEmail}</Heading>
      <p>{t.confirmSent(<strong>{step.email}</strong>)}</p>
      <p className="meta-txt">{t.confirmNext}</p>
      <div className="row account-step__actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void signIn(step.email, step.password, "confirm")}>{busy ? t.busy : t.confirmed}</button>
        <button className="btn btn-secondary" disabled={busy || cooldown.left > 0}
          onClick={() => void mail(() => invoke("account.resendConfirmation", step.email, locale), () => setNotice(t.resent))}>{resendLabel}</button>
      </div>
      <p className="field-note">{t.noMail}</p>
      <button type="button" className="link-btn" onClick={() => { setEmail(""); back("email"); }}>{t.otherEmail}</button>
    </section> : step.kind === "reset" && step.sentTo ? <section className="account-step stack-3" aria-labelledby="account-step-title">
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t.checkEmail}</Heading>
      <p>{t.resetSent(<strong>{step.sentTo}</strong>)}</p>
      <p className="meta-txt">{t.resetNext}</p>
      <div className="row account-step__actions">
        <button className="btn btn-primary" onClick={() => back("password")}>{t.backToSignIn}</button>
        <button className="btn btn-secondary" disabled={busy || cooldown.left > 0} onClick={() => void sendReset(step.sentTo!)}>{resendLabel}</button>
      </div>
      <p className="field-note">{t.noMail}</p>
    </section> : step.kind === "reset" ? <form className="account-step stack-3" noValidate aria-labelledby="account-step-title" onSubmit={e => {
      e.preventDefault();
      if (check("reset")) void sendReset(email.trim());
    }}>
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t.resetTitle}</Heading>
      <p className="meta-txt">{t.resetIntro}</p>
      {emailField}
      <div className="row"><button className="btn btn-primary" disabled={busy}>{busy ? t.busy : t.sendReset}</button></div>
      <button type="button" className="link-btn" onClick={() => back("password")}>{t.backToSignIn}</button>
    </form> : <form className="stack-3" noValidate onSubmit={e => {
      e.preventDefault();
      if (check("signIn")) void signIn(email.trim(), password, "form");
    }}>
      {emailField}
      <div className="field-group">
        <label className="field">{t.password}<input ref={passwordRef} className="input" type="password" autoComplete="current-password" value={password}
          aria-invalid={problem?.field === "password" || undefined} aria-describedby={problem?.field === "password" ? "account-problem" : "account-password-hint"}
          onChange={e => { setPassword(e.target.value); setProblem(null); }} /></label>
        <div className="account-password-foot">
          {problem?.field === "password"
            ? <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>
            : <span id="account-password-hint" className="field-note">{t.passwordHint}</span>}
          <button type="button" className="link-btn" onClick={() => { setStep({ kind: "reset", sentTo: null }); setProblem(null); setNotice(""); }}>{t.forgot}</button>
        </div>
      </div>
      {owner && email.trim() && email.trim().toLowerCase() !== owner.toLowerCase() && <p className="field-note">{t.otherAccount(owner)}</p>}
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? t.busy : t.signIn}</button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {
          if (!check("signUp")) return;
          const address = email.trim(), secret = password;
          void run(async () => {
            const result = await invoke("account.signUp", address, secret, locale);
            if (result.confirmationRequired) { cooldown.start(MAIL_INTERVAL); setStep({ kind: "confirm", email: address, password: secret }); }
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
