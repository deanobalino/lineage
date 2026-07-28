import { useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Button, ErrorNotice, LoadingRows } from "../components/Ui.js";
import { useAsync } from "../hooks.js";
import type { ShellContext } from "../shell/RepositoryShell.js";

function healthMessage(state?: string) {
  switch (state) {
    case "healthy": return "Events are reaching this server and no durable backlog remains.";
    case "pending": return "Coding sessions remain unblocked. Captured events are queued durably for replay.";
    case "replaying": return "Queued events are being replayed in their deterministic provider order.";
    case "degraded": return "Capture is failing open, but some evidence could not be saved. Review the failures below.";
    case "interrupted": return "Capture was interrupted after previously succeeding. New hook calls still fail open.";
    case "installed": return "Capture is installed. Complete a harness event to confirm end-to-end health.";
    default: return "No harness has confirmed capture on this server yet.";
  }
}

export function CaptureWorkspace() {
  const { repositoryId = "" } = useParams();
  const { repository, announce } = useOutletContext<ShellContext>();
  const capture = useAsync(
    (signal) => api.repositoryCapture(repositoryId, signal),
    [repositoryId]
  );
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  async function action(name: string, operation: () => Promise<unknown>) {
    setWorking(name);
    setError("");
    announce(`${name} started`);
    try {
      await operation();
      capture.reload();
      announce(`${name} complete`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : `${name} failed.`;
      setError(message);
      announce(message);
    } finally {
      setWorking("");
    }
  }

  if (capture.loading && !capture.data) {
    return <main className="focused-workspace"><LoadingRows count={10} /></main>;
  }
  if (capture.error || !capture.data) {
    return (
      <main className="focused-workspace">
        <ErrorNotice message={capture.error?.message ?? "Capture status is unavailable."} retry={capture.reload} />
      </main>
    );
  }

  const health = capture.data.health;
  return (
    <main className="focused-workspace capture-workspace">
      <header className="focused-header">
        <div>
          <h1>Capture</h1>
          <p>{repository.repository.name}</p>
        </div>
        <strong className={`health-state health-state--${health.state}`}>
          {health.state}
        </strong>
      </header>

      <section className="capture-overview">
        <h2>{healthMessage(health.state)}</h2>
        <dl>
          <div><dt>Queued</dt><dd>{health.pending}</dd></div>
          <div><dt>In flight</dt><dd>{health.claimed}</dd></div>
          <div><dt>Dead letters</dt><dd>{health.deadLetters}</dd></div>
          <div><dt>Incomplete evidence</dt><dd>{health.incompleteEvidence}</dd></div>
        </dl>
        {health.lastError ? <p className="capture-error">Last error: {health.lastError}</p> : null}
        {health.lastSuccessAt ? <p>Last confirmed: {new Date(health.lastSuccessAt).toLocaleString()}</p> : null}
      </section>

      {error ? <ErrorNotice message={error} /> : null}

      <section className="harnesses">
        <header>
          <h2>Coding harnesses</h2>
          <p>Install either or both. Existing unrelated hook configuration is preserved.</p>
        </header>
        {capture.data.harnesses.map((harness) => (
          <article key={harness.provider}>
            <div>
              <h3>{harness.provider === "codex" ? "Codex" : "GitHub Copilot CLI"}</h3>
              <p>{harness.configured ? "Configured" : "Not configured"}</p>
              <code>{harness.configurationPath}</code>
            </div>
            <Button
              variant={harness.configured ? "quiet" : "primary"}
              disabled={Boolean(working)}
              onClick={() => void action(
                `Install ${harness.provider}`,
                () => api.installCapture(repositoryId, harness.provider)
              )}
            >
              {working === `Install ${harness.provider}` ? "Installing…" : harness.configured ? "Reinstall" : "Install"}
            </Button>
          </article>
        ))}
      </section>

      <section className="capture-actions">
        <header>
          <h2>Recovery and replay</h2>
          <p>These actions operate on the server’s durable capture outbox.</p>
        </header>
        <div>
          <Button
            variant="primary"
            disabled={Boolean(working)}
            onClick={() => void action("Replay queue", api.replayCapture)}
          >
            {working === "Replay queue" ? "Replaying…" : "Replay queue"}
          </Button>
          <Button
            disabled={Boolean(working)}
            onClick={() => void action("Retry dead letters", () => api.deadLetters("retry"))}
          >
            Retry dead letters
          </Button>
          <Button
            variant="danger"
            disabled={Boolean(working)}
            onClick={() => void action("Discard dead letters", () => api.deadLetters("discard"))}
          >
            Discard dead letters
          </Button>
          <Button
            disabled={Boolean(working)}
            onClick={() => void action("Acknowledge incomplete evidence", api.acknowledgeIncomplete)}
          >
            Acknowledge incomplete evidence
          </Button>
          <Button
            disabled={Boolean(working)}
            onClick={() => void action("Recover Codex transcripts", () => api.recoverCodex(repositoryId))}
          >
            Recover Codex transcripts
          </Button>
        </div>
      </section>
    </main>
  );
}

