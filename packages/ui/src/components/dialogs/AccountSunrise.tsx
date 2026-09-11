import "./account-sunrise.css";

/** Full-window scenery. The sky clips the logo as it rises over the horizon. */
export function AccountSunrise() {
  return <div className="account-sunrise" aria-hidden="true">
    <div className="account-sunrise__sky">
      <div className="account-sunrise__rays" />
      <div className="account-sunrise__sun">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" draggable={false} />
      </div>
    </div>
    <svg className="account-sunrise__sea" viewBox="0 0 1000 150" preserveAspectRatio="none">
      <path className="account-sunrise__wave account-sunrise__wave--back" d="M-200 30 Q-100 8 0 30 T200 30 T400 30 T600 30 T800 30 T1000 30 T1200 30 V150 H-200Z" />
      <path className="account-sunrise__wave account-sunrise__wave--front" d="M-200 66 Q-100 44 0 66 T200 66 T400 66 T600 66 T800 66 T1000 66 T1200 66 V150 H-200Z" />
    </svg>
  </div>;
}
