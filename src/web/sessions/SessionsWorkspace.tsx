import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNotice, LoadingRows } from "../components/Ui.js";
import { useAsync } from "../hooks.js";

export function SessionsWorkspace() {
  const { repositoryId = "" } = useParams();
  const sessions = useAsync((signal) => api.sessions(repositoryId, signal), [repositoryId]);
  return (
    <main className="focused-workspace sessions-workspace">
      <header className="focused-header">
        <div>
          <h1>Sessions</h1>
          <p>Recorded provider activity linked to this repository.</p>
        </div>
        <a href={api.exportUrl(repositoryId, "agent-trace")}>Export Agent Trace</a>
      </header>
      {sessions.loading ? <LoadingRows count={10} /> : null}
      {sessions.error ? <ErrorNotice message={sessions.error.message} retry={sessions.reload} /> : null}
      {!sessions.loading && sessions.data?.sessions.length === 0 ? (
        <div className="empty-state">
          <h2>No linked sessions</h2>
          <p>Install capture or refresh after provider events have been recorded.</p>
        </div>
      ) : null}
      <div className="session-list">
        {sessions.data?.sessions.map((session) => (
          <Link
            key={`${session.provider}-${session.sessionId}`}
            to={`/r/${repositoryId}/sessions/${encodeURIComponent(session.sessionId)}`}
          >
            <span>
              <strong>{session.providerDisplayName}</strong>
              <small>{session.sessionId}</small>
            </span>
            <p>{session.prompt || "No prompt captured."}</p>
            <span>
              {session.filesEdited.length} files · tests {session.testsResult || "unknown"}
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}

