import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "~/lib/account";
import { invoke, messageOf } from "~/lib/api";
import { keys, useHubInfo } from "~/lib/queries";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { legalUrl } from "~/lib/legal";
import { openExternal } from "~/lib/shell";
import { AccountSunrise } from "./AccountSunrise";

const MIN_PASSWORD = 8;
/** Supabase sends one address at most one email a minute. */
const MAIL_INTERVAL = 60;

/** Failures the main process tags with a [code] this panel says in the reader's language; any other code keeps the server's words. */
const ERROR_KEY = {
  invalid_credentials: "account.error_invalid_credentials",
  email_not_confirmed: "account.error_email_not_confirmed",
  user_already_exists: "account.error_user_already_exists",
  email_exists: "account.error_email_exists",
  weak_password: "account.error_weak_password",
  email_address_invalid: "account.error_email_address_invalid",
  over_request_rate_limit: "account.error_over_request_rate_limit",
  over_email_send_rate_limit: "account.error_over_email_send_rate_limit",
  email_address_not_authorized: "account.error_email_address_not_authorized",
  signup_disabled: "account.error_signup_disabled",
  network: "account.error_network",
  other_account: "account.error_other_account",
  terms_required: "account.error_terms_required"
} as const satisfies Record<string, MessageKey>;
const errorKey = (code: string): MessageKey | undefined => (Object.hasOwn(ERROR_KEY, code) ? ERROR_KEY[code as keyof typeof ERROR_KEY] : undefined);
const LEGAL_KEY: Record<"terms" | "privacy", MessageKey> = { terms: "account.terms", privacy: "account.privacy" };

type Problem = { field: "email" | "password" | "terms"; text: string };
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
  const { locale, t, tx } = useI18n();
  const legalLink = (doc: "terms" | "privacy") =>
    <button type="button" className="link-btn" onClick={() => openExternal(legalUrl(doc, locale))}>{t(LEGAL_KEY[doc])}</button>;
  const account = useAccount();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  /** The signed-in panel's confirmation before the account is deleted, with the password it asks for. */
  const [deleting, setDeleting] = useState<{ password: string; problem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const cooldown = useCooldown();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const agreeRef = useRef<HTMLInputElement>(null);
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
  const resetSentTo = step.kind === "reset" && step.sentTo;
  useEffect(() => { if (step.kind !== "form") stepTitle.current?.focus(); }, [step.kind, resetSentTo]);
  const explain = (e: unknown) => {
    const wait = waitOf(e);
    if (wait) return t("account.mailWait", { n: wait });
    const text = messageOf(e);
    const code = codeOf(e);
    const key = code ? errorKey(code) : undefined;
    return code ? (key ? t(key, { min: MIN_PASSWORD }) : text.slice(code.length + 3)) : text;
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
      await Promise.all([qc.invalidateQueries({ queryKey: keys.account }), qc.invalidateQueries({ queryKey: keys.settings }), qc.invalidateQueries({ queryKey: keys.hubRemote })]);
    }
  };
  const signIn = (address: string, secret: string, from: "form" | "confirm" | "return") => run(async () => {
    try {
      await invoke("account.signIn", address, secret, true);
      setStep({ kind: "form" });
    } catch (e) {
      if (codeOf(e) !== "email_not_confirmed") throw e;
      setStep({ kind: "confirm", email: address, password: secret });
      if (from !== "return") setNotice(from === "form" ? t("account.notConfirmed") : t("account.stillNotConfirmed"));
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
    const found: Problem | null = !address ? { field: "email", text: t("account.needEmail") }
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? { field: "email", text: t("account.badEmail") }
      : mode === "reset" ? null
      : !password ? { field: "password", text: t("account.needPassword") }
      : mode === "signUp" && password.length < MIN_PASSWORD ? { field: "password", text: t("account.shortPassword", { min: MIN_PASSWORD }) }
      : !agreed ? { field: "terms", text: t("account.needAgree") }
      : null;
    setProblem(found);
    setNotice("");
    if (found) ({ email: emailRef, password: passwordRef, terms: agreeRef })[found.field].current?.focus();
    return !found;
  }
  const emailField = <div className="field-group">
    <label className="field">{t("account.email")}<input ref={emailRef} className="input" type="email" autoComplete="username" value={email}
      aria-invalid={problem?.field === "email" || undefined} aria-describedby={problem?.field === "email" ? "account-problem" : undefined}
      onChange={e => { setEmail(e.target.value); setProblem(null); }} /></label>
    {problem?.field === "email" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
  </div>;
  const resendLabel = cooldown.left ? t("account.resendIn", { n: cooldown.left }) : t("account.resend");
  // Never waits on the server or on another action: local use stays one click away.
  const continueLocally = () => void invoke("account.useLocally").then(info => qc.setQueryData(keys.account, info), e => setNotice(explain(e)));
  return <div className="panel stack-3" aria-busy={busy || switchingTo !== null}>
    {!entrance ? <>
      <h2 className="sec-title">{t("account.title")}</h2>
      <p className="meta-txt">{t("account.intro")}</p>
    </> : step.kind === "form" && <p className="meta-txt">{t("account.why")}</p>}
    {account.isPending ? <p>{t("account.loading")}</p> : account.error ? <>
      <p role="alert">{explain(account.error)}</p><button className="btn btn-secondary" onClick={() => void account.refetch()}>{t("account.retry")}</button>
    </> : account.data?.user && deleting ? <form className="account-step stack-3" noValidate aria-labelledby="account-delete-title" onSubmit={e => {
      e.preventDefault();
      if (!deleting.password) return;
      const secret = deleting.password;
      void run(async () => {
        try {
          await invoke("account.deleteAccount", secret);
          setDeleting(null);
        } catch (err) {
          setDeleting({ password: "", problem: codeOf(err) === "invalid_credentials" ? t("account.wrongPassword") : explain(err) });
        }
      });
    }}>
      <Heading id="account-delete-title" className="account-step__title">{t("account.deleteTitle")}</Heading>
      <p>{tx("account.deleteIntro", { email: <strong>{account.data.user.email}</strong> })}</p>
      <p className="meta-txt"><strong>{t("account.deleteGoesLabel")}</strong> {t("account.deleteGoes")}</p>
      <p className="meta-txt"><strong>{t("account.deleteStaysLabel")}</strong> {t("account.deleteStays")}</p>
      <div className="field-group">
        <label className="field">{t("account.deletePassword")}<input className="input" type="password" autoComplete="current-password" autoFocus value={deleting.password}
          aria-invalid={!!deleting.problem || undefined} aria-describedby={deleting.problem ? "account-delete-problem" : undefined}
          onChange={e => setDeleting({ password: e.target.value, problem: null })} /></label>
        {deleting.problem && <span id="account-delete-problem" className="field-note is-error" role="alert">{deleting.problem}</span>}
      </div>
      <div className="row account-step__actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>{t("account.cancel")}</button>
        <button className="btn btn-danger" disabled={busy || !deleting.password}>{busy ? t("account.deleting") : t("account.deleteForever")}</button>
      </div>
    </form> : account.data?.user ? <>
      <p>{account.data.user.email}</p>
      <p className="meta-txt">{t("account.pending")}: {account.data.pending}</p>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => invoke("account.sync"))}>{busy ? t("account.busy") : t("account.sync")}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t("account.signOut")}</button>
      </div>
      {account.data.conflicts.map(c => <div key={c.id} className="panel stack-3">
        <p>{t("account.conflict")}: {c.id}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t("account.local")}: {JSON.stringify(c.local, null, 2)}{"\n"}{t("account.cloud")}: {JSON.stringify(c.cloud, null, 2)}</pre>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => invoke("account.resolve", c.id, "local"))}>{t("account.local")}</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => invoke("account.resolve", c.id, "cloud"))}>{t("account.cloud")}</button>
        </div>
      </div>)}
      <button type="button" className="link-btn is-danger account-delete" disabled={busy} onClick={() => { setNotice(""); setDeleting({ password: "", problem: null }); }}>{t("account.deleteAccount")}</button>
    </> : switchingTo !== null ? <p role="status">{t("account.switching", { email: switchingTo })}</p> : step.kind === "confirm" ? <section className="account-step stack-3" aria-labelledby="account-step-title">
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t("account.checkEmail")}</Heading>
      <p>{tx("account.confirmSent", { email: <strong>{step.email}</strong> })}</p>
      <p className="meta-txt">{t("account.confirmNext")}</p>
      <div className="row account-step__actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void signIn(step.email, step.password, "confirm")}>{busy ? t("account.busy") : t("account.confirmed")}</button>
        <button className="btn btn-secondary" disabled={busy || cooldown.left > 0}
          onClick={() => void mail(() => invoke("account.resendConfirmation", step.email, locale), () => setNotice(t("account.resent")))}>{resendLabel}</button>
      </div>
      <p className="field-note">{t("account.noMail")}</p>
      <button type="button" className="link-btn" onClick={() => { setEmail(""); back("email"); }}>{t("account.otherEmail")}</button>
    </section> : step.kind === "reset" && step.sentTo ? <section className="account-step stack-3" aria-labelledby="account-step-title">
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t("account.checkEmail")}</Heading>
      <p>{tx("account.resetSent", { email: <strong>{step.sentTo}</strong> })}</p>
      <p className="meta-txt">{t("account.resetNext")}</p>
      <div className="row account-step__actions">
        <button className="btn btn-primary" onClick={() => back("password")}>{t("account.backToSignIn")}</button>
        <button className="btn btn-secondary" disabled={busy || cooldown.left > 0} onClick={() => void sendReset(step.sentTo!)}>{resendLabel}</button>
      </div>
      <p className="field-note">{t("account.noMail")}</p>
    </section> : step.kind === "reset" ? <form className="account-step stack-3" noValidate aria-labelledby="account-step-title" onSubmit={e => {
      e.preventDefault();
      if (check("reset")) void sendReset(email.trim());
    }}>
      <Heading id="account-step-title" ref={stepTitle} tabIndex={-1} className="account-step__title">{t("account.resetTitle")}</Heading>
      <p className="meta-txt">{t("account.resetIntro")}</p>
      {emailField}
      <div className="row"><button className="btn btn-primary" disabled={busy}>{busy ? t("account.busy") : t("account.sendReset")}</button></div>
      <button type="button" className="link-btn" onClick={() => back("password")}>{t("account.backToSignIn")}</button>
    </form> : <form className="stack-3" noValidate onSubmit={e => {
      e.preventDefault();
      if (check("signIn")) void signIn(email.trim(), password, "form");
    }}>
      {emailField}
      <div className="field-group">
        <label className="field">{t("account.password")}<input ref={passwordRef} className="input" type="password" autoComplete="current-password" value={password}
          aria-invalid={problem?.field === "password" || undefined} aria-describedby={problem?.field === "password" ? "account-problem" : "account-password-hint"}
          onChange={e => { setPassword(e.target.value); setProblem(null); }} /></label>
        <div className="account-password-foot">
          {problem?.field === "password"
            ? <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>
            : <span id="account-password-hint" className="field-note">{t("account.passwordHint", { min: MIN_PASSWORD })}</span>}
          <button type="button" className="link-btn" onClick={() => { setStep({ kind: "reset", sentTo: null }); setProblem(null); setNotice(""); }}>{t("account.forgot")}</button>
        </div>
      </div>
      <div className="field-group">
        <label className="account-agree">
          <input ref={agreeRef} type="checkbox" checked={agreed}
            aria-invalid={problem?.field === "terms" || undefined} aria-describedby={problem?.field === "terms" ? "account-problem" : undefined}
            onChange={e => { setAgreed(e.target.checked); if (problem?.field === "terms") setProblem(null); }} />
          <span>{tx("account.agree", { terms: legalLink("terms"), privacy: legalLink("privacy") })}</span>
        </label>
        {problem?.field === "terms" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
      </div>
      {owner && email.trim() && email.trim().toLowerCase() !== owner.toLowerCase() && <p className="field-note">{t("account.otherAccount", { owner })}</p>}
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? t("account.busy") : t("account.signIn")}</button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {
          if (!check("signUp")) return;
          const address = email.trim(), secret = password;
          void run(async () => {
            const result = await invoke("account.signUp", address, secret, locale, true);
            if (result.confirmationRequired) { cooldown.start(MAIL_INTERVAL); setStep({ kind: "confirm", email: address, password: secret }); }
          });
        }}>{t("account.signUp")}</button>
      </div>
    </form>}
    {!account.data?.user && account.data?.offlineAccess && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t("account.signOut")}</button>}
    {account.data?.status.detail && !(entrance && account.data.status.state === "unavailable") && <p role="status">{account.data.status.detail}</p>}
    {notice && <p role="status">{notice}</p>}
    {entrance && !account.data?.user && switchingTo === null && <div className="account-local">
      <button type="button" className="link-btn" onClick={continueLocally}>{t("account.useLocally")}</button>
      <p className="field-note">{t("account.localNote")}</p>
    </div>}
  </div>;
}

export function AccountGate({ children }: { children: ReactNode }) {
  const hub = useHubInfo();
  const account = useAccount();
  const [entered, setEntered] = useState(false);
  if (hub.isPending) return null;
  if (hub.data?.cloudEnabled && !account.data?.user && !account.data?.offlineAccess && !account.data?.localOnly) return <main className="sheet account-gate">
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
