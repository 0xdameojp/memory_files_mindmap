import { useEffect, useState } from "react";

import { DriveMindMap } from "./components/drive-mind-map";

function readInitialError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error") ?? undefined;

  if (error) {
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
