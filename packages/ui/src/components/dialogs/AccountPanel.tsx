import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "~/lib/account";
import { invoke, messageOf } from "~/lib/api";
import { useHubInfo } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";
import { legalUrl } from "~/lib/legal";
import { openExternal } from "~/lib/shell";
import { AccountSunrise } from "./AccountSunrise";

const MIN_PASSWORD = 8;
/** Supabase sends one address at most one email a minute. */
const MAIL_INTERVAL = 60;

const copy = {
  en: {
    title: "Tomrade account", intro: "Your account synchronizes the Hub catalog and preferences. Project content stays in your project folders.", email: "Email", password: "Password", signIn: "Sign in", signUp: "Create account", signOut: "Sign out", sync: "Sync Hub", busy: "Working…", pending: "Pending changes", local: "Keep local", cloud: "Use cloud", conflict: "Choose which version of this Hub record to keep", loading: "Loading account…", retry: "Retry",
    passwordHint: `A new account needs at least ${MIN_PASSWORD} characters.`,
    why: "An account keeps your project list and preferences in sync across your computers.",
    useLocally: "Use without an account",
    localNote: "Your projects stay on this computer. You can sign in later in Settings\u00a0→\u00a0Hub.",
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
    agree: (terms: ReactNode, privacy: ReactNode) => <>I agree to the {terms} and the {privacy}.</>,
    terms: "Terms of Service", privacy: "Privacy Policy",
    needAgree: "Tick this to agree to the Terms of Service and Privacy Policy first.",
    deleteAccount: "Delete account…",
    deleteTitle: "Delete your Tomrade account?",
    deleteIntro: (email: ReactNode) => <>This deletes {email} for good. It can't be undone.</>,
    deleteGoesLabel: "Deleted:",
    deleteGoes: "the account, your synced preferences and project list, your plugin reports and your publisher profile.",
    deleteStaysLabel: "Kept:",
    deleteStays: "your projects on this computer and in their git remotes, and plugins you published (write to support@tomrade.com to take them down). The next account to sign in here takes over these projects.",
    deletePassword: "Your password, to confirm",
    deleteForever: "Delete account", deleting: "Deleting…", cancel: "Cancel",
    wrongPassword: "That password isn't right.",
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
      other_account: "This computer's projects belong to another account. Sign in with that account.",
      terms_required: "Tick the box to agree to the Terms of Service and Privacy Policy first."
    } as Record<string, string>
  },
  zh: {
    title: "Tomrade 账号", intro: "账号同步 Hub 目录和用户偏好。项目内容仍保存在各自的项目文件夹中。", email: "邮箱", password: "密码", signIn: "登录", signUp: "注册账号", signOut: "退出登录", sync: "同步 Hub", busy: "处理中…", pending: "待同步变更", local: "保留本地版本", cloud: "使用云端版本", conflict: "请选择要保留的 Hub 记录版本", loading: "正在读取账号…", retry: "重试",
    passwordHint: `注册新账号需要至少 ${MIN_PASSWORD} 位密码。`,
    why: "账号用于在多台电脑之间同步项目列表和偏好设置。",
    useLocally: "不登录，本地使用",
    localNote: "项目只保存在这台电脑上。之后可以在 设置\u00a0→\u00a0主目录 中登录。",
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
    agree: (terms: ReactNode, privacy: ReactNode) => <>我已阅读并同意{terms}和{privacy}。</>,
    terms: "《用户条款》", privacy: "《隐私政策》",
    needAgree: "请先勾选同意用户条款和隐私政策。",
    deleteAccount: "注销账号…",
    deleteTitle: "注销你的 Tomrade 账号？",
    deleteIntro: (email: ReactNode) => <>{email} 将被永久注销，无法恢复。</>,
    deleteGoesLabel: "删除：",
    deleteGoes: "账号本身、同步的偏好设置和项目列表、你的插件举报和发布者资料。",
    deleteStaysLabel: "保留：",
    deleteStays: "这台电脑上的项目和它们的 git 远程仓库，以及你发布的插件（如需下架，请写信到 support@tomrade.com）。下一个在这里登录的账号会接管这些项目。",
    deletePassword: "输入密码以确认",
    deleteForever: "注销账号", deleting: "正在注销…", cancel: "取消",
    wrongPassword: "密码不正确。",
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
      other_account: "这台电脑上的项目属于另一个账号，请使用那个账号登录。",
      terms_required: "请先勾选同意用户条款和隐私政策。"
    } as Record<string, string>
  },
  "zh-Hant": {
    why: "帳號用於在多台電腦之間同步專案列表和偏好設定。",
    useLocally: "不登入，在本機使用",
    localNote: "專案只保存在這台電腦上。之後可以在 設定\u00a0→\u00a0主目錄 中登入。",
    title: "Tomrade 帳號", intro: "帳號會同步 Hub 目錄和使用者偏好。專案內容仍保存在各自的專案資料夾中。", email: "電子郵件", password: "密碼", signIn: "登入", signUp: "註冊帳號", signOut: "登出", sync: "同步 Hub", busy: "處理中…", pending: "待同步變更", local: "保留本機版本", cloud: "使用雲端版本", conflict: "請選擇要保留的 Hub 記錄版本", loading: "正在讀取帳號…", retry: "重試",
    passwordHint: `註冊新帳號需要至少 ${MIN_PASSWORD} 個字元的密碼。`,
    needEmail: "請輸入電子郵件。", badEmail: "電子郵件格式不正確。", needPassword: "請輸入密碼。", shortPassword: `註冊新帳號的密碼至少需要 ${MIN_PASSWORD} 個字元。`,
    otherAccount: (owner: string) => `改用其他帳號會開啟該帳號自己的專案；${owner} 的專案仍保留在這台電腦上，重新登入即可回來。`,
    switching: (email: string) => `正在開啟 ${email} 的專案…`,
    forgot: "忘記密碼？",
    checkEmail: "請查收郵件",
    confirmSent: (email: ReactNode) => <>確認連結已寄到 {email}。</>,
    confirmNext: "開啟連結啟用帳號，然後回到這裡，Tomrade 會自動幫你登入。",
    confirmed: "我已確認，登入",
    notConfirmed: "這個電子郵件尚未確認。請開啟我們寄給你的確認連結，或重新寄送一封。",
    stillNotConfirmed: "尚未確認。請先開啟郵件中的連結，再按一次這裡。",
    resend: "重新寄送", resendIn: (n: number) => `${n} 秒後可重新寄送`,
    resent: "新的連結已寄出，請使用最新那封郵件中的連結。",
    noMail: "沒收到？請看看垃圾郵件，並確認電子郵件地址沒有寫錯。",
    otherEmail: "改用其他電子郵件",
    resetTitle: "重設密碼",
    resetIntro: "輸入帳號的電子郵件，我們會寄一個連結，讓你在瀏覽器中設定新密碼。",
    sendReset: "寄送重設連結",
    resetSent: (email: ReactNode) => <>如果 {email} 註冊過 Tomrade，重設連結已經寄出。</>,
    resetNext: "在連結開啟的網頁上設定新密碼，然後回到這裡用新密碼登入。",
    backToSignIn: "返回登入",
    mailWait: (n: number) => `剛剛已經寄過郵件到這個信箱了。請先查收，或 ${n} 秒後再試。`,
    agree: (terms: ReactNode, privacy: ReactNode) => <>我已閱讀並同意{terms}和{privacy}。</>,
    terms: "《服務條款》", privacy: "《隱私權政策》",
    needAgree: "請先勾選同意服務條款和隱私權政策。",
    deleteAccount: "刪除帳號…",
    deleteTitle: "要刪除你的 Tomrade 帳號嗎？",
    deleteIntro: (email: ReactNode) => <>{email} 將被永久刪除，無法復原。</>,
    deleteGoesLabel: "刪除：",
    deleteGoes: "帳號本身、同步的偏好設定和專案清單、你的外掛檢舉和發布者資料。",
    deleteStaysLabel: "保留：",
    deleteStays: "這台電腦上的專案和它們的 git 遠端儲存庫，以及你發布的外掛（如需下架，請寫信到 support@tomrade.com）。下一個在這裡登入的帳號會接管這些專案。",
    deletePassword: "輸入密碼以確認",
    deleteForever: "刪除帳號", deleting: "正在刪除…", cancel: "取消",
    wrongPassword: "密碼不正確。",
    errors: {
      invalid_credentials: "電子郵件或密碼不正確。",
      email_not_confirmed: "請先確認電子郵件：開啟我們寄給你的確認連結，然後再登入。",
      user_already_exists: "這個電子郵件已經註冊過了，請直接登入；忘記密碼可以點「忘記密碼？」。",
      email_exists: "這個電子郵件已經註冊過了，請直接登入；忘記密碼可以點「忘記密碼？」。",
      weak_password: `密碼強度太弱，請至少使用 ${MIN_PASSWORD} 個字元。`,
      email_address_invalid: "請輸入有效的電子郵件地址。",
      over_request_rate_limit: "嘗試次數過多，請稍候一分鐘再試。",
      over_email_send_rate_limit: "Tomrade 目前寄出的郵件過多，請稍後再試。",
      email_address_not_authorized: "暫時無法寄送郵件到這個信箱，請稍後再試。",
      signup_disabled: "目前暫不開放註冊新帳號。",
      network: "無法連線到 Tomrade 伺服器，請檢查網路後重試。",
      other_account: "這台電腦上的專案屬於另一個帳號，請使用該帳號登入。",
      terms_required: "請先勾選同意服務條款和隱私權政策。"
    } as Record<string, string>
  },
  ja: {
    why: "アカウントがあると、プロジェクトの一覧と設定を複数のコンピューターで同期できます。",
    useLocally: "アカウントなしで使う",
    localNote: "プロジェクトはこのコンピューターにだけ保存されます。あとから 設定\u00a0→\u00a0ハブ でログインできます。",
    title: "Tomrade アカウント", intro: "アカウントは Hub カタログと設定を同期します。プロジェクトの内容は各プロジェクトフォルダに残ります。", email: "メールアドレス", password: "パスワード", signIn: "ログイン", signUp: "アカウントを作成", signOut: "ログアウト", sync: "Hub を同期", busy: "処理中…", pending: "未同期の変更", local: "ローカル版を残す", cloud: "クラウド版を使う", conflict: "残す Hub レコードのバージョンを選んでください", loading: "アカウントを読み込み中…", retry: "再試行",
    passwordHint: `新しいアカウントには ${MIN_PASSWORD} 文字以上のパスワードが必要です。`,
    needEmail: "メールアドレスを入力してください。", badEmail: "メールアドレスの形式が正しくありません。", needPassword: "パスワードを入力してください。", shortPassword: `新しいアカウントのパスワードは ${MIN_PASSWORD} 文字以上にしてください。`,
    otherAccount: (owner: string) => `別のアカウントでは、そのアカウント自身のプロジェクトが開きます。${owner} のプロジェクトはこのコンピュータに残り、再ログインすると戻ります。`,
    switching: (email: string) => `${email} のプロジェクトを開いています…`,
    forgot: "パスワードをお忘れですか？",
    checkEmail: "メールを確認してください",
    confirmSent: (email: ReactNode) => <>{email} に確認リンクを送信しました。</>,
    confirmNext: "リンクを開いてアカウントを有効にしてから、ここに戻ってください。Tomrade が自動でログインします。",
    confirmed: "確認しました。ログイン",
    notConfirmed: "このメールアドレスはまだ確認されていません。送信したリンクを開くか、新しいメールを再送してください。",
    stillNotConfirmed: "まだ確認されていません。先にメール内のリンクを開いてから、もう一度押してください。",
    resend: "メールを再送", resendIn: (n: number) => `${n} 秒後に再送できます`,
    resent: "新しいリンクを送信しました。有効なのは最新のリンクだけです。",
    noMail: "届いていませんか？迷惑メールフォルダと、アドレスが正しいかを確認してください。",
    otherEmail: "別のメールアドレスを使う",
    resetTitle: "パスワードの再設定",
    resetIntro: "アカウントのメールアドレスを入力してください。ブラウザで新しいパスワードを設定するためのリンクを送信します。",
    sendReset: "再設定リンクを送信",
    resetSent: (email: ReactNode) => <>{email} に Tomrade アカウントがあれば、再設定リンクを送信しました。</>,
    resetNext: "リンク先のページで新しいパスワードを設定し、ここに戻ってそのパスワードでログインしてください。",
    backToSignIn: "ログインに戻る",
    mailWait: (n: number) => `1 分以内にこのアドレスへメールを送信済みです。受信トレイを確認するか、${n} 秒後にもう一度お試しください。`,
    agree: (terms: ReactNode, privacy: ReactNode) => <>{terms}と{privacy}に同意します。</>,
    terms: "利用規約", privacy: "プライバシーポリシー",
    needAgree: "先に利用規約とプライバシーポリシーへの同意にチェックしてください。",
    deleteAccount: "アカウントを削除…",
    deleteTitle: "Tomrade アカウントを削除しますか？",
    deleteIntro: (email: ReactNode) => <>{email} を完全に削除します。元に戻すことはできません。</>,
    deleteGoesLabel: "削除されるもの：",
    deleteGoes: "アカウント、同期された設定とプロジェクト一覧、プラグインの報告、パブリッシャープロフィール。",
    deleteStaysLabel: "残るもの：",
    deleteStays: "このコンピュータ上のプロジェクトとその git リモート、公開したプラグイン（取り下げるには support@tomrade.com までご連絡ください）。次にここでログインしたアカウントがこれらのプロジェクトを引き継ぎます。",
    deletePassword: "確認のためパスワードを入力",
    deleteForever: "アカウントを削除", deleting: "削除中…", cancel: "キャンセル",
    wrongPassword: "パスワードが正しくありません。",
    errors: {
      invalid_credentials: "メールアドレスまたはパスワードが正しくありません。",
      email_not_confirmed: "先にメールアドレスを確認してください。送信したリンクを開いてからログインしてください。",
      user_already_exists: "このメールアドレスのアカウントは既にあります。ログインするか、思い出せない場合は「パスワードをお忘れですか？」を選んでください。",
      email_exists: "このメールアドレスのアカウントは既にあります。ログインするか、思い出せない場合は「パスワードをお忘れですか？」を選んでください。",
      weak_password: `パスワードが弱すぎます。${MIN_PASSWORD} 文字以上にしてください。`,
      email_address_invalid: "有効なメールアドレスを入力してください。",
      over_request_rate_limit: "試行回数が多すぎます。1 分待ってからもう一度お試しください。",
      over_email_send_rate_limit: "Tomrade が送信したメールが多すぎます。しばらくしてからお試しください。",
      email_address_not_authorized: "Tomrade はまだこのアドレスにメールを送信できません。しばらくしてからお試しください。",
      signup_disabled: "現在、新しいアカウントは作成できません。",
      network: "Tomrade サーバーに接続できません。接続を確認してから、もう一度お試しください。",
      other_account: "このコンピュータのプロジェクトは別のアカウントのものです。そのアカウントでログインしてください。",
      terms_required: "先にチェックを入れて、利用規約とプライバシーポリシーに同意してください。"
    } as Record<string, string>
  },
  es: {
    why: "Una cuenta mantiene tu lista de proyectos y tus preferencias sincronizadas entre tus ordenadores.",
    useLocally: "Usar sin cuenta",
    localNote: "Tus proyectos se quedan en este ordenador. Puedes iniciar sesión más tarde en Ajustes\u00a0→\u00a0Hub.",
    title: "Cuenta de Tomrade", intro: "Tu cuenta sincroniza el catálogo del Hub y tus preferencias. El contenido de los proyectos se queda en sus carpetas.", email: "Correo electrónico", password: "Contraseña", signIn: "Iniciar sesión", signUp: "Crear cuenta", signOut: "Cerrar sesión", sync: "Sincronizar Hub", busy: "Procesando…", pending: "Cambios pendientes", local: "Mantener local", cloud: "Usar la nube", conflict: "Elige qué versión de este registro del Hub conservar", loading: "Cargando cuenta…", retry: "Reintentar",
    passwordHint: `Una cuenta nueva necesita al menos ${MIN_PASSWORD} caracteres.`,
    needEmail: "Escribe tu correo electrónico.", badEmail: "Eso no parece una dirección de correo.", needPassword: "Escribe tu contraseña.", shortPassword: `Usa al menos ${MIN_PASSWORD} caracteres para una cuenta nueva.`,
    otherAccount: (owner: string) => `Otra cuenta abre sus propios proyectos. Los proyectos de ${owner} se quedan en este ordenador para cuando vuelvas a iniciar sesión.`,
    switching: (email: string) => `Abriendo los proyectos de ${email}…`,
    forgot: "¿Olvidaste tu contraseña?",
    checkEmail: "Revisa tu correo",
    confirmSent: (email: ReactNode) => <>Enviamos un enlace de confirmación a {email}.</>,
    confirmNext: "Ábrelo para activar tu cuenta y luego vuelve aquí. Tomrade inicia sesión por sí solo.",
    confirmed: "Ya confirmé, iniciar sesión",
    notConfirmed: "Este correo aún no está confirmado. Abre el enlace que te enviamos o pide uno nuevo.",
    stillNotConfirmed: "Aún no está confirmado. Abre primero el enlace del correo y luego vuelve a pulsar aquí.",
    resend: "Reenviar correo", resendIn: (n: number) => `Reenviar en ${n} s`,
    resent: "Enviamos un enlace nuevo. Solo funciona el más reciente.",
    noMail: "¿No llegó nada? Revisa la carpeta de spam o correo no deseado, y que la dirección sea correcta.",
    otherEmail: "Usar otro correo",
    resetTitle: "Restablecer la contraseña",
    resetIntro: "Escribe el correo de tu cuenta. Te enviaremos un enlace para elegir una contraseña nueva en tu navegador.",
    sendReset: "Enviar enlace",
    resetSent: (email: ReactNode) => <>Si {email} tiene una cuenta de Tomrade, el enlace para restablecer ya va en camino.</>,
    resetNext: "Elige una contraseña nueva en la página que abre el enlace y luego vuelve aquí para iniciar sesión con ella.",
    backToSignIn: "Volver a iniciar sesión",
    mailWait: (n: number) => `Enviamos un correo a esta dirección hace menos de un minuto. Revisa tu bandeja de entrada o inténtalo de nuevo en ${n} s.`,
    agree: (terms: ReactNode, privacy: ReactNode) => <>Acepto los {terms} y la {privacy}.</>,
    terms: "Términos del servicio", privacy: "Política de privacidad",
    needAgree: "Primero marca esta casilla para aceptar los Términos del servicio y la Política de privacidad.",
    deleteAccount: "Eliminar cuenta…",
    deleteTitle: "¿Eliminar tu cuenta de Tomrade?",
    deleteIntro: (email: ReactNode) => <>Esto elimina {email} para siempre. No se puede deshacer.</>,
    deleteGoesLabel: "Se elimina:",
    deleteGoes: "la cuenta, tus preferencias y lista de proyectos sincronizadas, tus reportes de plugins y tu perfil de publicador.",
    deleteStaysLabel: "Se conserva:",
    deleteStays: "tus proyectos en este ordenador y en sus remotos de git, y los plugins que publicaste (escribe a support@tomrade.com para retirarlos). La próxima cuenta que inicie sesión aquí se quedará con estos proyectos.",
    deletePassword: "Tu contraseña, para confirmar",
    deleteForever: "Eliminar cuenta", deleting: "Eliminando…", cancel: "Cancelar",
    wrongPassword: "Esa contraseña no es correcta.",
    errors: {
      invalid_credentials: "Correo o contraseña incorrectos.",
      email_not_confirmed: "Primero confirma tu correo: abre el enlace que te enviamos y luego inicia sesión.",
      user_already_exists: "Ya existe una cuenta con este correo. Inicia sesión o elige «¿Olvidaste tu contraseña?» si no la recuerdas.",
      email_exists: "Ya existe una cuenta con este correo. Inicia sesión o elige «¿Olvidaste tu contraseña?» si no la recuerdas.",
      weak_password: `Esa contraseña es demasiado débil. Usa al menos ${MIN_PASSWORD} caracteres.`,
      email_address_invalid: "Escribe una dirección de correo válida.",
      over_request_rate_limit: "Demasiados intentos. Espera un minuto y vuelve a intentarlo.",
      over_email_send_rate_limit: "Tomrade ha enviado demasiados correos por ahora. Inténtalo más tarde.",
      email_address_not_authorized: "Tomrade aún no puede enviar correos a esta dirección. Inténtalo más tarde.",
      signup_disabled: "Ahora mismo no se pueden crear cuentas nuevas.",
      network: "No se puede conectar con el servidor de Tomrade. Revisa tu conexión y vuelve a intentarlo.",
      other_account: "Los proyectos de este ordenador pertenecen a otra cuenta. Inicia sesión con esa cuenta.",
      terms_required: "Primero marca la casilla para aceptar los Términos del servicio y la Política de privacidad."
    } as Record<string, string>
  },
  de: {
    why: "Ein Konto hält deine Projektliste und Einstellungen auf allen deinen Computern synchron.",
    useLocally: "Ohne Konto verwenden",
    localNote: "Deine Projekte bleiben auf diesem Computer. Anmelden kannst du dich später unter Einstellungen\u00a0→\u00a0Hub.",
    title: "Tomrade-Konto", intro: "Dein Konto synchronisiert den Hub-Katalog und deine Einstellungen. Projektinhalte bleiben in deinen Projektordnern.", email: "E-Mail", password: "Passwort", signIn: "Anmelden", signUp: "Konto erstellen", signOut: "Abmelden", sync: "Hub synchronisieren", busy: "Wird bearbeitet…", pending: "Ausstehende Änderungen", local: "Lokal behalten", cloud: "Cloud verwenden", conflict: "Wähle, welche Version dieses Hub-Eintrags du behalten willst", loading: "Konto wird geladen…", retry: "Erneut versuchen",
    passwordHint: `Ein neues Konto braucht mindestens ${MIN_PASSWORD} Zeichen.`,
    needEmail: "Gib deine E-Mail-Adresse ein.", badEmail: "Das sieht nicht wie eine E-Mail-Adresse aus.", needPassword: "Gib dein Passwort ein.", shortPassword: `Verwende für ein neues Konto mindestens ${MIN_PASSWORD} Zeichen.`,
    otherAccount: (owner: string) => `Ein anderes Konto öffnet seine eigenen Projekte. Die Projekte von ${owner} bleiben auf diesem Computer, bis du dich wieder anmeldest.`,
    switching: (email: string) => `Projekte von ${email} werden geöffnet…`,
    forgot: "Passwort vergessen?",
    checkEmail: "Prüfe deine E-Mails",
    confirmSent: (email: ReactNode) => <>Wir haben einen Bestätigungslink an {email} gesendet.</>,
    confirmNext: "Öffne ihn, um dein Konto zu aktivieren, und komm dann hierher zurück. Tomrade meldet dich automatisch an.",
    confirmed: "Bestätigt, anmelden",
    notConfirmed: "Diese E-Mail-Adresse ist noch nicht bestätigt. Öffne den Link, den wir dir geschickt haben, oder fordere einen neuen an.",
    stillNotConfirmed: "Noch nicht bestätigt. Öffne zuerst den Link in der E-Mail und drück dann noch einmal hier.",
    resend: "E-Mail erneut senden", resendIn: (n: number) => `Erneut senden in ${n} s`,
    resent: "Wir haben einen neuen Link gesendet. Nur der neueste funktioniert.",
    noMail: "Nichts angekommen? Prüfe deinen Spam-Ordner und ob die Adresse stimmt.",
    otherEmail: "Andere E-Mail-Adresse verwenden",
    resetTitle: "Passwort zurücksetzen",
    resetIntro: "Gib die E-Mail-Adresse deines Kontos ein. Wir schicken dir einen Link, mit dem du im Browser ein neues Passwort wählst.",
    sendReset: "Link zum Zurücksetzen senden",
    resetSent: (email: ReactNode) => <>Falls {email} ein Tomrade-Konto hat, ist ein Link zum Zurücksetzen unterwegs.</>,
    resetNext: "Wähle auf der Seite, die der Link öffnet, ein neues Passwort, komm dann hierher zurück und melde dich damit an.",
    backToSignIn: "Zurück zur Anmeldung",
    mailWait: (n: number) => `Wir haben dieser Adresse vor weniger als einer Minute eine E-Mail geschickt. Prüfe deinen Posteingang oder versuch es in ${n} s erneut.`,
    agree: (terms: ReactNode, privacy: ReactNode) => <>Ich stimme den {terms} und der {privacy} zu.</>,
    terms: "Nutzungsbedingungen", privacy: "Datenschutzerklärung",
    needAgree: "Hake dies zuerst an, um den Nutzungsbedingungen und der Datenschutzerklärung zuzustimmen.",
    deleteAccount: "Konto löschen…",
    deleteTitle: "Dein Tomrade-Konto löschen?",
    deleteIntro: (email: ReactNode) => <>Damit wird {email} endgültig gelöscht. Das lässt sich nicht rückgängig machen.</>,
    deleteGoesLabel: "Gelöscht:",
    deleteGoes: "das Konto, deine synchronisierten Einstellungen und Projektliste, deine Plugin-Meldungen und dein Herausgeberprofil.",
    deleteStaysLabel: "Behalten:",
    deleteStays: "deine Projekte auf diesem Computer und in ihren git-Remotes sowie Plugins, die du veröffentlicht hast (schreib an support@tomrade.com, um sie entfernen zu lassen). Das nächste Konto, das sich hier anmeldet, übernimmt diese Projekte.",
    deletePassword: "Dein Passwort zur Bestätigung",
    deleteForever: "Konto löschen", deleting: "Wird gelöscht…", cancel: "Abbrechen",
    wrongPassword: "Das Passwort ist nicht richtig.",
    errors: {
      invalid_credentials: "Falsche E-Mail-Adresse oder falsches Passwort.",
      email_not_confirmed: "Bestätige zuerst deine E-Mail-Adresse: Öffne den Link, den wir dir geschickt haben, und melde dich dann an.",
      user_already_exists: "Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Melde dich an oder wähle „Passwort vergessen?“, falls du es nicht mehr weißt.",
      email_exists: "Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Melde dich an oder wähle „Passwort vergessen?“, falls du es nicht mehr weißt.",
      weak_password: `Das Passwort ist zu schwach. Verwende mindestens ${MIN_PASSWORD} Zeichen.`,
      email_address_invalid: "Gib eine gültige E-Mail-Adresse ein.",
      over_request_rate_limit: "Zu viele Versuche. Warte eine Minute und versuch es dann erneut.",
      over_email_send_rate_limit: "Tomrade hat vorerst zu viele E-Mails gesendet. Versuch es später erneut.",
      email_address_not_authorized: "Tomrade kann an diese Adresse noch keine E-Mails senden. Versuch es später erneut.",
      signup_disabled: "Neue Konten können gerade nicht erstellt werden.",
      network: "Der Tomrade-Server ist nicht erreichbar. Prüfe deine Verbindung und versuch es dann erneut.",
      other_account: "Die Projekte auf diesem Computer gehören zu einem anderen Konto. Melde dich mit diesem Konto an.",
      terms_required: "Hake zuerst das Kästchen an, um den Nutzungsbedingungen und der Datenschutzerklärung zuzustimmen."
    } as Record<string, string>
  },
  fr: {
    why: "Un compte synchronise votre liste de projets et vos préférences entre vos ordinateurs.",
    useLocally: "Utiliser sans compte",
    localNote: "Vos projets restent sur cet ordinateur. Vous pourrez vous connecter plus tard dans Paramètres\u00a0→\u00a0Hub.",
    title: "Compte Tomrade", intro: "Votre compte synchronise le catalogue du Hub et vos préférences. Le contenu des projets reste dans leurs dossiers.", email: "E-mail", password: "Mot de passe", signIn: "Se connecter", signUp: "Créer un compte", signOut: "Se déconnecter", sync: "Synchroniser le Hub", busy: "Traitement…", pending: "Modifications en attente", local: "Garder la version locale", cloud: "Utiliser le cloud", conflict: "Choisissez la version de cet enregistrement du Hub à conserver", loading: "Chargement du compte…", retry: "Réessayer",
    passwordHint: `Un nouveau compte nécessite au moins ${MIN_PASSWORD} caractères.`,
    needEmail: "Saisissez votre e-mail.", badEmail: "Cela ne ressemble pas à une adresse e-mail.", needPassword: "Saisissez votre mot de passe.", shortPassword: `Utilisez au moins ${MIN_PASSWORD} caractères pour un nouveau compte.`,
    otherAccount: (owner: string) => `Un autre compte ouvre ses propres projets. Les projets de ${owner} restent sur cet ordinateur pour votre prochaine connexion.`,
    switching: (email: string) => `Ouverture des projets de ${email}…`,
    forgot: "Mot de passe oublié ?",
    checkEmail: "Consultez vos e-mails",
    confirmSent: (email: ReactNode) => <>Nous avons envoyé un lien de confirmation à {email}.</>,
    confirmNext: "Ouvrez-le pour activer votre compte, puis revenez ici. Tomrade vous connecte automatiquement.",
    confirmed: "C’est confirmé, me connecter",
    notConfirmed: "Cet e-mail n’est pas encore confirmé. Ouvrez le lien que nous vous avons envoyé, ou demandez-en un nouveau.",
    stillNotConfirmed: "Pas encore confirmé. Ouvrez d’abord le lien dans l’e-mail, puis appuyez de nouveau ici.",
    resend: "Renvoyer l’e-mail", resendIn: (n: number) => `Renvoyer dans ${n} s`,
    resent: "Nous avons envoyé un nouveau lien. Seul le plus récent fonctionne.",
    noMail: "Rien reçu ? Vérifiez votre dossier de spam ou de courrier indésirable, et que l’adresse est correcte.",
    otherEmail: "Utiliser un autre e-mail",
    resetTitle: "Réinitialiser votre mot de passe",
    resetIntro: "Saisissez l’e-mail de votre compte. Nous vous enverrons un lien pour choisir un nouveau mot de passe dans votre navigateur.",
    sendReset: "Envoyer le lien de réinitialisation",
    resetSent: (email: ReactNode) => <>Si {email} possède un compte Tomrade, un lien de réinitialisation est en route.</>,
    resetNext: "Choisissez un nouveau mot de passe sur la page ouverte par le lien, puis revenez ici pour vous connecter avec.",
    backToSignIn: "Retour à la connexion",
    mailWait: (n: number) => `Nous avons envoyé un e-mail à cette adresse il y a moins d’une minute. Consultez votre boîte de réception, ou réessayez dans ${n} s.`,
    agree: (terms: ReactNode, privacy: ReactNode) => <>J’accepte les {terms} et la {privacy}.</>,
    terms: "Conditions d’utilisation", privacy: "Politique de confidentialité",
    needAgree: "Cochez d’abord cette case pour accepter les Conditions d’utilisation et la Politique de confidentialité.",
    deleteAccount: "Supprimer le compte…",
    deleteTitle: "Supprimer votre compte Tomrade ?",
    deleteIntro: (email: ReactNode) => <>Cela supprime {email} définitivement. Cette action est irréversible.</>,
    deleteGoesLabel: "Supprimé :",
    deleteGoes: "le compte, vos préférences et votre liste de projets synchronisées, vos signalements de plugins et votre profil d’éditeur.",
    deleteStaysLabel: "Conservé :",
    deleteStays: "vos projets sur cet ordinateur et dans leurs dépôts git distants, ainsi que les plugins que vous avez publiés (écrivez à support@tomrade.com pour les retirer). Le prochain compte qui se connecte ici reprend ces projets.",
    deletePassword: "Votre mot de passe, pour confirmer",
    deleteForever: "Supprimer le compte", deleting: "Suppression…", cancel: "Annuler",
    wrongPassword: "Ce mot de passe est incorrect.",
    errors: {
      invalid_credentials: "E-mail ou mot de passe incorrect.",
      email_not_confirmed: "Confirmez d’abord votre e-mail : ouvrez le lien que nous vous avons envoyé, puis connectez-vous.",
      user_already_exists: "Un compte existe déjà avec cet e-mail. Connectez-vous, ou choisissez « Mot de passe oublié ? » si vous ne vous en souvenez plus.",
      email_exists: "Un compte existe déjà avec cet e-mail. Connectez-vous, ou choisissez « Mot de passe oublié ? » si vous ne vous en souvenez plus.",
      weak_password: `Ce mot de passe est trop faible. Utilisez au moins ${MIN_PASSWORD} caractères.`,
      email_address_invalid: "Saisissez une adresse e-mail valide.",
      over_request_rate_limit: "Trop de tentatives. Patientez une minute, puis réessayez.",
      over_email_send_rate_limit: "Tomrade a envoyé trop d’e-mails pour le moment. Réessayez plus tard.",
      email_address_not_authorized: "Tomrade ne peut pas encore envoyer d’e-mail à cette adresse. Réessayez plus tard.",
      signup_disabled: "Impossible de créer de nouveaux comptes pour le moment.",
      network: "Impossible de joindre le serveur Tomrade. Vérifiez votre connexion, puis réessayez.",
      other_account: "Les projets de cet ordinateur appartiennent à un autre compte. Connectez-vous avec ce compte.",
      terms_required: "Cochez d’abord la case pour accepter les Conditions d’utilisation et la Politique de confidentialité."
    } as Record<string, string>
  }
};

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
  const { locale } = useI18n();
  const t = copy[locale];
  const legalLink = (doc: "terms" | "privacy") =>
    <button type="button" className="link-btn" onClick={() => openExternal(legalUrl(doc, locale))}>{t[doc]}</button>;
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
      await invoke("account.signIn", address, secret, true);
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
      : !agreed ? { field: "terms", text: t.needAgree }
      : null;
    setProblem(found);
    setNotice("");
    if (found) ({ email: emailRef, password: passwordRef, terms: agreeRef })[found.field].current?.focus();
    return !found;
  }
  const emailField = <div className="field-group">
    <label className="field">{t.email}<input ref={emailRef} className="input" type="email" autoComplete="username" value={email}
      aria-invalid={problem?.field === "email" || undefined} aria-describedby={problem?.field === "email" ? "account-problem" : undefined}
      onChange={e => { setEmail(e.target.value); setProblem(null); }} /></label>
    {problem?.field === "email" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
  </div>;
  const resendLabel = cooldown.left ? t.resendIn(cooldown.left) : t.resend;
  // Never waits on the server or on another action: local use stays one click away.
  const continueLocally = () => void invoke("account.useLocally").then(info => qc.setQueryData(["account"], info), e => setNotice(explain(e)));
  return <div className="panel stack-3" aria-busy={busy || switchingTo !== null}>
    {!entrance ? <>
      <h2 className="sec-title">{t.title}</h2>
      <p className="meta-txt">{t.intro}</p>
    </> : step.kind === "form" && <p className="meta-txt">{t.why}</p>}
    {account.isPending ? <p>{t.loading}</p> : account.error ? <>
      <p role="alert">{explain(account.error)}</p><button className="btn btn-secondary" onClick={() => void account.refetch()}>{t.retry}</button>
    </> : account.data?.user && deleting ? <form className="account-step stack-3" noValidate aria-labelledby="account-delete-title" onSubmit={e => {
      e.preventDefault();
      if (!deleting.password) return;
      const secret = deleting.password;
      void run(async () => {
        try {
          await invoke("account.deleteAccount", secret);
          setDeleting(null);
        } catch (err) {
          setDeleting({ password: "", problem: codeOf(err) === "invalid_credentials" ? t.wrongPassword : explain(err) });
        }
      });
    }}>
      <Heading id="account-delete-title" className="account-step__title">{t.deleteTitle}</Heading>
      <p>{t.deleteIntro(<strong>{account.data.user.email}</strong>)}</p>
      <p className="meta-txt"><strong>{t.deleteGoesLabel}</strong> {t.deleteGoes}</p>
      <p className="meta-txt"><strong>{t.deleteStaysLabel}</strong> {t.deleteStays}</p>
      <div className="field-group">
        <label className="field">{t.deletePassword}<input className="input" type="password" autoComplete="current-password" autoFocus value={deleting.password}
          aria-invalid={!!deleting.problem || undefined} aria-describedby={deleting.problem ? "account-delete-problem" : undefined}
          onChange={e => setDeleting({ password: e.target.value, problem: null })} /></label>
        {deleting.problem && <span id="account-delete-problem" className="field-note is-error" role="alert">{deleting.problem}</span>}
      </div>
      <div className="row account-step__actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>{t.cancel}</button>
        <button className="btn btn-danger" disabled={busy || !deleting.password}>{busy ? t.deleting : t.deleteForever}</button>
      </div>
    </form> : account.data?.user ? <>
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
      <button type="button" className="link-btn is-danger account-delete" disabled={busy} onClick={() => { setNotice(""); setDeleting({ password: "", problem: null }); }}>{t.deleteAccount}</button>
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
      <div className="field-group">
        <label className="account-agree">
          <input ref={agreeRef} type="checkbox" checked={agreed}
            aria-invalid={problem?.field === "terms" || undefined} aria-describedby={problem?.field === "terms" ? "account-problem" : undefined}
            onChange={e => { setAgreed(e.target.checked); if (problem?.field === "terms") setProblem(null); }} />
          <span>{t.agree(legalLink("terms"), legalLink("privacy"))}</span>
        </label>
        {problem?.field === "terms" && <span id="account-problem" className="field-note is-error" role="alert">{problem.text}</span>}
      </div>
      {owner && email.trim() && email.trim().toLowerCase() !== owner.toLowerCase() && <p className="field-note">{t.otherAccount(owner)}</p>}
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button className="btn btn-primary" disabled={busy}>{busy ? t.busy : t.signIn}</button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {
          if (!check("signUp")) return;
          const address = email.trim(), secret = password;
          void run(async () => {
            const result = await invoke("account.signUp", address, secret, locale, true);
            if (result.confirmationRequired) { cooldown.start(MAIL_INTERVAL); setStep({ kind: "confirm", email: address, password: secret }); }
          });
        }}>{t.signUp}</button>
      </div>
    </form>}
    {!account.data?.user && account.data?.offlineAccess && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => invoke("account.signOut"))}>{t.signOut}</button>}
    {account.data?.status.detail && !(entrance && account.data.status.state === "unavailable") && <p role="status">{account.data.status.detail}</p>}
    {notice && <p role="status">{notice}</p>}
    {entrance && !account.data?.user && switchingTo === null && <div className="account-local">
      <button type="button" className="link-btn" onClick={continueLocally}>{t.useLocally}</button>
      <p className="field-note">{t.localNote}</p>
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
