import { useEffect, useState } from "react";

import { DriveMindMap } from "./components/drive-mind-map";

// URL の ?error= には決まったコードだけを受け付け、文言はここで決める。
// 任意の文章を画面に出せると、なりすましの案内文を表示させられてしまうため。
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: "Google でのログインがキャンセルされたか、許可されませんでした。",
  oauth_state: "ログインの確認に失敗しました。もう一度お試しください。",
  oauth_failed: "Google でのログインを完了できませんでした。もう一度お試しください。",
};

function readInitialError() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  const error = code ? (AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES.oauth_failed) : undefined;

  if (code) {
    // リロードでエラーが再表示されないよう URL から取り除く
    params.delete("error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }

  return error;
}

export function App() {
  const [initialError] = useState(readInitialError);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/session", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<{ signedIn?: boolean }>)
      .then((data) => {
        if (!cancelled) setSignedIn(Boolean(data.signedIn));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app-page">
      {signedIn === null ? null : (
        <DriveMindMap initialSignedIn={signedIn} initialError={initialError} />
      )}
    </main>
  );
}
