import { useEffect, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation
} from "react-router-dom";
import { api } from "./api.js";
import { LoginPage } from "./auth/LoginPage.js";
import { CaptureWorkspace } from "./capture/CaptureWorkspace.js";
import { ExploreWorkspace } from "./explore/ExploreWorkspace.js";
import { RepositoriesPage } from "./repositories/RepositoriesPage.js";
import { ReviewWorkspace } from "./review/ReviewWorkspace.js";
import { SessionWorkspace } from "./sessions/SessionWorkspace.js";
import { SessionsWorkspace } from "./sessions/SessionsWorkspace.js";
import { RepositoryShell } from "./shell/RepositoryShell.js";

function Protected({
  authenticated,
  children
}: {
  authenticated: boolean;
  children: React.ReactNode;
}) {
  const location = useLocation();
  return authenticated ? (
    children
  ) : (
    <Navigate
      to="/login"
      replace
      state={{ from: `${location.pathname}${location.search}` }}
    />
  );
}

function intendedRoute(state: unknown): string | undefined {
  return (
    typeof state === "object" &&
    state &&
    "from" in state &&
    typeof state.from === "string"
  )
    ? state.from
    : undefined;
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "authenticated" | "anonymous">(
    "checking"
  );
  const location = useLocation();

  useEffect(() => {
    void api.session().then(
      () => setAuth("authenticated"),
      () => setAuth("anonymous")
    );
  }, []);

  useEffect(
    () => api.onUnauthorized(() => setAuth("anonymous")),
    []
  );

  if (auth === "checking") {
    return (
      <main className="boot-screen" aria-label="Loading Lineage">
        <div className="wordmark">LINEAGE</div>
        <span />
      </main>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          auth === "authenticated" && !intendedRoute(location.state) ? (
            <Navigate to="/repositories" replace />
          ) : (
            <LoginPage onLogin={() => setAuth("authenticated")} />
          )
        }
      />
      <Route
        path="/repositories"
        element={
          <Protected authenticated={auth === "authenticated"}>
            <RepositoriesPage />
          </Protected>
        }
      />
      <Route
        path="/r/:repositoryId"
        element={
          <Protected authenticated={auth === "authenticated"}>
            <RepositoryShell onLogout={() => setAuth("anonymous")} />
          </Protected>
        }
      >
        <Route index element={<Navigate to="review" replace />} />
        <Route path="review" element={<ReviewWorkspace />} />
        <Route path="explore" element={<ExploreWorkspace />} />
        <Route path="capture" element={<CaptureWorkspace />} />
        <Route path="sessions" element={<SessionsWorkspace />} />
        <Route path="sessions/:provider/:sessionId" element={<SessionWorkspace />} />
      </Route>
      <Route
        path="*"
        element={
          <Navigate
            to={auth === "authenticated" ? "/repositories" : "/login"}
            replace
          />
        }
      />
    </Routes>
  );
}
