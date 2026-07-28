import { useParams } from "react-router-dom";
import type { Provider } from "../../shared/api-contracts.js";
import { api } from "../api.js";
import { ErrorNotice, LoadingRows } from "../components/Ui.js";
import { useAsync } from "../hooks.js";

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function SessionWorkspace() {
  const { repositoryId = "", provider = "", sessionId = "" } = useParams();
  const detail = useAsync(
    (signal) => api.sessionDetail(repositoryId, provider as Provider, sessionId, signal),
    [repositoryId, provider, sessionId]
  );
  if (detail.loading) return <main className="focused-workspace"><LoadingRows count={14} /></main>;
  if (detail.error || !detail.data) {
    return (
      <main className="focused-workspace">
        <ErrorNotice message={detail.error?.message ?? "Session is unavailable."} retry={detail.reload} />
      </main>
    );
  }
  const session = detail.data.session;
  return (
    <main className="focused-workspace session-workspace">
      <header className="focused-header">
        <div>
          <span className="evidence-source">Recorded provenance</span>
          <h1>{session.providerDisplayName}</h1>
          <code>{session.sessionId}</code>
        </div>
        <div className="header-actions">
          <a
            href={api.exportUrl(repositoryId, "session-markdown", {
              provider: provider as Provider,
              session: sessionId
            })}
            onClick={(event) => {
              event.preventDefault();
              void api.download(event.currentTarget.href).catch(() => undefined);
            }}
          >
            Export Markdown
          </a>
          <a
            href={api.exportUrl(repositoryId, "session-json", {
              provider: provider as Provider,
              session: sessionId
            })}
            onClick={(event) => {
              event.preventDefault();
              void api.download(event.currentTarget.href).catch(() => undefined);
            }}
          >
            Export JSON
          </a>
        </div>
      </header>
      <section className="session-lede">
        <h2>Prompt</h2>
        <p>{session.prompt || "No prompt captured."}</p>
        <span>Tests {session.testsResult || "unknown"}</span>
      </section>
      <div className="session-columns">
        <section>
          <h2>Tools and commands</h2>
          <h3>Tools</h3>
          <ul>{session.toolsUsed.map((tool) => <li key={tool}>{tool}</li>)}</ul>
          <h3>Commands</h3>
          <ul>{session.commandsRun.map((command) => <li key={command}><code>{command}</code></li>)}</ul>
          <h3>Tests</h3>
          <ul>{session.testsRun.map((test) => <li key={test}><code>{test}</code></li>)}</ul>
        </section>
        <section>
          <h2>Decision record</h2>
          <JsonBlock value={session.decisions} />
          <h2>External constraints</h2>
          <JsonBlock value={session.externalConstraints} />
        </section>
      </div>
      <details open>
        <summary>Evidence timeline and transcript</summary>
        <JsonBlock value={detail.data.evidence} />
      </details>
      <details>
        <summary>Provenance graph</summary>
        <p>{detail.data.graph.nodes.length} nodes · {detail.data.graph.edges.length} edges</p>
        <JsonBlock value={detail.data.graph} />
      </details>
    </main>
  );
}
