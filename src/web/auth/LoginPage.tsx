import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { Button } from "../components/Ui.js";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api.login(token.trim());
      onLogin();
      const intended =
        typeof location.state === "object" &&
        location.state &&
        "from" in location.state &&
        typeof location.state.from === "string"
          ? location.state.from
          : "/repositories";
      navigate(intended, { replace: true });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : undefined;
      setError(
        apiError?.status === 429
          ? "Too many attempts. Wait briefly, then try the current operator token."
          : caught instanceof Error
            ? caught.message
            : "Login failed."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <section className="login__panel" aria-labelledby="login-title">
        <div className="wordmark">LINEAGE</div>
        <div className="login__copy">
          <h1 id="login-title">Open the review instrument</h1>
          <p>
            Enter the one-time operator token shown when this Lineage server
            was first started.
          </p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="operator-token">Operator token</label>
          <input
            id="operator-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            minLength={20}
            required
            autoFocus
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <Button
            variant="primary"
            type="submit"
            disabled={submitting || token.trim().length < 20}
          >
            {submitting ? "Checking token…" : "Continue"}
          </Button>
        </form>
        <p className="login__footnote">
          Repository contents stay on this host. Your session is short-lived
          and stored in an HttpOnly cookie.
        </p>
      </section>
    </main>
  );
}

