import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Link,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams
} from "react-router-dom";
import { api } from "../api.js";
import {
  BackIcon,
  EvidenceIcon,
  ExportIcon,
  SearchIcon
} from "../components/Icons.js";
import {
  Button,
  ErrorNotice,
  LoadingRows,
  Sheet
} from "../components/Ui.js";
import { useAsync } from "../hooks.js";
import type { ShellContext } from "../shell/RepositoryShell.js";
import type {
  ChangedFile,
  DiffLine,
  LineExplanation,
  ReviewMetrics
} from "../types.js";
import type { DiffSide, ExplainQuery } from "../../shared/api-contracts.js";

const FILE_GROUPS: Array<ChangedFile["status"]> = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "unknown"
];

const KEYWORD =
  /\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|new|null|of|return|static|switch|throw|true|try|type|typeof|undefined|var|while)\b/g;

function CodeText({ text }: { text: string }) {
  const parts = text.split(KEYWORD);
  const keywords = text.match(KEYWORD) ?? [];
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${part}-${index}`}>
          {part}
          {keywords[index] ? <span className="token-keyword">{keywords[index]}</span> : null}
        </Fragment>
      ))}
    </>
  );
}

function metricText(metrics: ReviewMetrics) {
  return [
    `${metrics.files} ${metrics.files === 1 ? "file" : "files"}`,
    `${metrics.commits} ${metrics.commits === 1 ? "commit" : "commits"}`,
    `${metrics.sessions} ${metrics.sessions === 1 ? "session" : "sessions"}`,
    `+${metrics.additions}`,
    `−${metrics.deletions}`,
    `${metrics.explainedPercent}% recorded`
  ];
}

function lineNumber(line: DiffLine) {
  return line.newLine ?? line.oldLine;
}

function lineSelection(
  path: string,
  line: number,
  base: string,
  side: DiffSide,
  previousPath?: string
): ExplainQuery {
  return {
    path,
    line,
    base,
    side,
    ...(previousPath ? { previousPath } : {})
  };
}

function download(event: React.MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  void api.download(url).catch(() => undefined);
}

export function EvidenceInspector({
  explanation,
  loading,
  error,
  repositoryId,
  path,
  line,
  base,
  side,
  previousPath,
  close,
  mobile
}: {
  explanation: LineExplanation | undefined;
  loading: boolean;
  error: Error | undefined;
  repositoryId: string;
  path: string;
  line: number | undefined;
  base?: string;
  side?: DiffSide;
  previousPath?: string;
  close?: () => void;
  mobile?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (mobile && explanation) headingRef.current?.focus();
  }, [explanation, mobile]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!line || !question.trim()) return;
    setAsking(true);
    setAnswer("");
    try {
      const result = await api.followUp(repositoryId, {
        path,
        line,
        question: question.trim(),
        ...(base ? { base } : {}),
        ...(side ? { side } : {}),
        ...(previousPath ? { previousPath } : {})
      });
      setAnswer(result.answer);
    } catch (caught) {
      setAnswer(caught instanceof Error ? caught.message : "Follow-up failed.");
    } finally {
      setAsking(false);
    }
  }

  if (loading) {
    return <aside className="evidence-inspector"><LoadingRows count={10} /></aside>;
  }
  if (error) {
    return <aside className="evidence-inspector"><ErrorNotice message={error.message} /></aside>;
  }
  if (!explanation) {
    return (
      <aside className="evidence-inspector evidence-inspector--empty">
        <EvidenceIcon />
        <h2>Select a changed line</h2>
        <p>Lineage will place recorded provider evidence or Git inference beside the diff.</p>
      </aside>
    );
  }

  const recorded = Boolean(explanation.provider);
  const decision = explanation.architectureDecision;
  return (
    <aside
      className={`evidence-inspector evidence-inspector--${recorded ? "recorded" : "git"}`}
      aria-label="Line evidence"
    >
      <header className="evidence-inspector__header">
        {close ? (
          <Button className="evidence-back" onClick={close}>
            <BackIcon /> Back to diff
          </Button>
        ) : null}
        <div>
          <span className="evidence-source">
            <EvidenceIcon />
            {recorded ? "Recorded provenance" : "Git inference only"}
          </span>
          <h2 ref={headingRef} tabIndex={-1}>{explanation.provider ?? "Git history"}</h2>
        </div>
        <a
          className="icon-button"
          href={api.exportUrl(repositoryId, "explanation", {
            path,
            line: line ?? 1,
            ...(base ? { base } : {}),
            ...(side ? { side } : {}),
            ...(previousPath ? { previousPath } : {})
          })}
          onClick={(event) => download(event, event.currentTarget.href)}
          aria-label="Export explanation"
          title="Export explanation"
        >
          <ExportIcon />
        </a>
      </header>
      <section className="evidence-answer">
        <h3>Why this changed</h3>
        <p>{explanation.answer}</p>
        <span>{Math.round(explanation.confidence * 100)}% confidence · {explanation.decisionProvenance.label}</span>
      </section>

      {explanation.evidenceCards[0] ? (
        <details open>
          <summary>Prompt</summary>
          <p>{explanation.evidenceCards[0].body}</p>
        </details>
      ) : null}
      {decision ? (
        <>
          <details open>
            <summary>Decision</summary>
            <p>{decision.decision}</p>
            <small>{decision.context}</small>
          </details>
          <details open={decision.alternatives.length > 0}>
            <summary>Alternatives</summary>
            {decision.alternatives.length ? (
              <ul>
                {decision.alternatives.map((option) => (
                  <li key={option.id}>
                    {option.text}
                    {option.rationale ? <small>{option.rationale}</small> : null}
                  </li>
                ))}
              </ul>
            ) : <p>No alternatives were captured.</p>}
          </details>
          <details open={decision.externalConstraints.length > 0}>
            <summary>External constraints</summary>
            {decision.externalConstraints.length ? (
              <ul>
                {decision.externalConstraints.map((constraint) => (
                  <li key={constraint.id}>
                    {constraint.summary}
                    <small>{constraint.filePath}{constraint.startLine ? `:${constraint.startLine}` : ""}</small>
                  </li>
                ))}
              </ul>
            ) : <p>No external constraints were captured.</p>}
          </details>
        </>
      ) : null}
      <details open>
        <summary>Tests</summary>
        <p>{explanation.evidenceCards.find((card) => card.title === "Tests")?.body ?? "No test result was captured."}</p>
        <small>{explanation.removalAssessment}</small>
      </details>
      <details open={Boolean(explanation.gitEvidence)}>
        <summary>Git evidence</summary>
        {explanation.gitEvidence ? (
          <dl className="git-evidence">
            <dt>Commit</dt><dd>{explanation.gitEvidence.commitSha.slice(0, 10)} · {explanation.gitEvidence.commitSummary}</dd>
            <dt>Author</dt><dd>{explanation.gitEvidence.author}</dd>
            {explanation.gitEvidence.authoredAt ? (
              <><dt>Date</dt><dd>{new Date(explanation.gitEvidence.authoredAt).toLocaleString()}</dd></>
            ) : null}
          </dl>
        ) : <p>No Git blame evidence was available.</p>}
      </details>
      {explanation.sessionId && explanation.sessionProvider ? (
        <section className="open-session">
          <h3>Open session</h3>
          <code>{explanation.sessionId}</code>
          <Link to={`/r/${repositoryId}/sessions/${encodeURIComponent(explanation.sessionProvider)}/${encodeURIComponent(explanation.sessionId)}`}>
            View full session
          </Link>
        </section>
      ) : null}
      <form className="follow-up" onSubmit={ask}>
        <label htmlFor={`follow-up-${mobile ? "mobile" : "desktop"}`}>Ask a follow-up</label>
        <div>
          <input
            id={`follow-up-${mobile ? "mobile" : "desktop"}`}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What evidence supports this?"
          />
          <Button variant="primary" type="submit" disabled={asking || !question.trim()}>
            {asking ? "Asking…" : "Ask"}
          </Button>
        </div>
        {answer ? <output>{answer}</output> : null}
      </form>
    </aside>
  );
}

export function ReviewWorkspace() {
  const { repositoryId = "" } = useParams();
  const { repository } = useOutletContext<ShellContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const navigate = useNavigate();
  const selectedLineRef = useRef<HTMLButtonElement>(null);
  const base = searchParams.get("base") ?? repository.defaultBase ?? "";

  const review = useAsync(
    (signal) => api.review(repositoryId, base, signal),
    [repositoryId, base]
  );
  const selectedPath =
    searchParams.get("file") ??
    review.data?.files[0]?.path ??
    "";
  const selectedLine = Number(searchParams.get("line")) || undefined;
  const selectedSide: DiffSide =
    searchParams.get("side") === "old" ? "old" : "new";
  const selectedFile = review.data?.files.find((file) => file.path === selectedPath);
  const previousPath =
    selectedFile?.previousPath ??
    (selectedSide === "old" ? selectedPath : undefined);
  const diff = useAsync(
    (signal) =>
      selectedPath
        ? api.diff(repositoryId, base, selectedPath, signal)
        : Promise.resolve({ path: "", raw: "", hunks: [], sessions: [] }),
    [repositoryId, base, selectedPath]
  );
  const explanation = useAsync(
    (signal) =>
      selectedLine
        ? api.explain(
            repositoryId,
            lineSelection(
              selectedPath,
              selectedLine,
              base,
              selectedSide,
              previousPath
            ),
            signal
          )
        : Promise.resolve(undefined),
    [repositoryId, selectedPath, selectedLine, base, selectedSide, previousPath]
  );

  useEffect(() => {
    if (!searchParams.get("file") && review.data?.files[0]) {
      const next = new URLSearchParams(searchParams);
      next.set("base", base);
      next.set("file", review.data.files[0].path);
      setSearchParams(next, { replace: true });
    }
  }, [base, review.data, searchParams, setSearchParams]);

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return review.data?.files.filter((file) => file.path.toLowerCase().includes(query)) ?? [];
  }, [filter, review.data]);

  function selectFile(path: string) {
    const next = new URLSearchParams(searchParams);
    next.set("base", base);
    next.set("file", path);
    next.delete("line");
    next.delete("side");
    setSearchParams(next);
    setFilesOpen(false);
    setEvidenceOpen(false);
  }

  function selectLine(line: number, side: "old" | "new") {
    const next = new URLSearchParams(searchParams);
    next.set("line", String(line));
    next.set("side", side);
    setSearchParams(next);
  }

  function closeEvidence() {
    setEvidenceOpen(false);
    requestAnimationFrame(() => selectedLineRef.current?.focus());
  }

  const fileRail = (
    <aside className="file-rail" aria-label="Changed files">
      <label className="file-filter">
        <SearchIcon />
        <span className="sr-only">Filter changed files</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files"
        />
      </label>
      {FILE_GROUPS.map((status) => {
        const files = filteredFiles.filter((file) => file.status === status);
        if (!files.length) return null;
        return (
          <section key={status}>
            <header>
              <h2>{status[0]?.toUpperCase()}{status.slice(1)}</h2>
              <span>{files.length}</span>
            </header>
            {files.map((file) => (
              <button
                type="button"
                key={`${file.status}-${file.path}`}
                className={file.path === selectedPath ? "selected" : ""}
                onClick={() => selectFile(file.path)}
              >
                <span className={`file-status file-status--${file.status}`}>
                  {file.status === "added" ? "+" : file.status === "deleted" ? "−" : file.status[0]?.toUpperCase()}
                </span>
                <span>
                  <strong>{file.path}</strong>
                  {file.previousPath ? <small>from {file.previousPath}</small> : null}
                  {file.providers.length ? <small>{file.providers.join(", ")}</small> : <small>Git only</small>}
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </aside>
  );

  return (
    <main className="review-workspace">
      <header className="review-summary">
        <nav className="mobile-mode-nav" aria-label="Repository mode">
          <span aria-current="page">Review</span>
          <button type="button" onClick={() => navigate(`/r/${repositoryId}/explore`)}>Explore</button>
        </nav>
        {review.data ? (
          <div className="metrics" aria-label="Review summary">
            {metricText(review.data.metrics).map((metric) => <span key={metric}>{metric}</span>)}
          </div>
        ) : <LoadingRows count={2} />}
        <Button className="files-button" onClick={() => setFilesOpen(true)}>
          {review.data?.files.length ?? 0} files
        </Button>
      </header>
      {review.error ? <ErrorNotice message={review.error.message} retry={review.reload} /> : null}
      <div className="review-regions">
        {fileRail}
        <section className="diff-region" aria-label="Branch diff">
          <header className="diff-file-header">
            <span className={`file-status file-status--${review.data?.files.find((file) => file.path === selectedPath)?.status ?? "unknown"}`}>
              {review.data?.files.find((file) => file.path === selectedPath)?.status[0]?.toUpperCase() ?? "·"}
            </span>
            <h1>{selectedPath || "No changed files"}</h1>
            {selectedPath ? (
              <a
                href={api.exportUrl(repositoryId, "explanation", {
                  path: selectedPath,
                  line: selectedLine ?? 1,
                  base,
                  side: selectedSide,
                  ...(previousPath ? { previousPath } : {})
                })}
                onClick={(event) => download(event, event.currentTarget.href)}
              >
                Export
              </a>
            ) : null}
          </header>
          <div className="diff-scroll" tabIndex={0}>
            {diff.loading ? <LoadingRows count={12} /> : null}
            {diff.error ? <ErrorNotice message={diff.error.message} retry={diff.reload} /> : null}
            {!diff.loading && diff.data?.hunks.length === 0 ? (
              <div className="empty-state">
                <h2>No text diff</h2>
                <p>This file may be binary, deleted, or unchanged against {base}.</p>
              </div>
            ) : null}
            {diff.data?.hunks.map((hunk) => (
              <section className="diff-hunk" key={hunk.id} aria-label={hunk.header}>
                <header>{hunk.header}</header>
                <div className="diff-lines">
                  {hunk.lines.map((entry, index) => {
                    const number = lineNumber(entry);
                    const side = entry.kind === "deletion" ? "old" : "new";
                    const selected = number === selectedLine && side === selectedSide;
                    const matchedSession = number
                      ? diff.data?.sessions.find((session) =>
                          session.lineRanges.some(
                            (range) =>
                              range.file === selectedPath &&
                              number >= range.start &&
                              number <= range.end
                          )
                        )
                      : undefined;
                    return (
                      <button
                        type="button"
                        key={`${hunk.id}-${index}-${entry.kind}`}
                        ref={selected ? selectedLineRef : undefined}
                        className={`diff-line diff-line--${entry.kind}${selected ? " selected" : ""}`}
                        onClick={() => number && selectLine(number, side)}
                        disabled={!number}
                        aria-label={`${entry.kind} line ${number ?? ""}: ${entry.text}`}
                        aria-pressed={selected}
                      >
                        <span className="diff-line__old">{entry.oldLine ?? ""}</span>
                        <span className="diff-line__new">{entry.newLine ?? ""}</span>
                        <span className="diff-line__sign" aria-hidden="true">
                          {entry.kind === "addition" ? "+" : entry.kind === "deletion" ? "−" : " "}
                        </span>
                        <code><CodeText text={entry.text} /></code>
                        {matchedSession ? (
                          <span
                            className="provenance-marker"
                            title={`${matchedSession.providerDisplayName} recorded provenance`}
                          >
                            {matchedSession.providerDisplayName}
                          </span>
                        ) : null}
                        {selected ? <span className="evidence-seam" aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          {selectedLine ? (
            <button
              type="button"
              className="mobile-evidence-trigger"
              onClick={() => setEvidenceOpen(true)}
            >
              <span>
                <small>{explanation.data?.provider ? "Recorded provenance" : "Git inference only"}</small>
                <strong>{explanation.data?.provider ?? "Git history"}</strong>
                <span>Why this changed</span>
              </span>
              <span>Open evidence</span>
            </button>
          ) : null}
        </section>
        <EvidenceInspector
          explanation={explanation.data}
          loading={explanation.loading}
          error={explanation.error}
          repositoryId={repositoryId}
          path={selectedPath}
          line={selectedLine}
          base={base}
          side={selectedSide}
          {...(previousPath ? { previousPath } : {})}
        />
      </div>
      <Sheet
        open={filesOpen}
        onOpenChange={setFilesOpen}
        title="Changed files"
        description={`Compared with ${base}`}
        className="file-sheet"
      >
        {fileRail}
      </Sheet>
      <Sheet
        open={evidenceOpen && Boolean(selectedLine)}
        onOpenChange={(open) => open ? setEvidenceOpen(true) : closeEvidence()}
        title="Line evidence"
        className="evidence-sheet"
      >
        <EvidenceInspector
          explanation={explanation.data}
          loading={explanation.loading}
          error={explanation.error}
          repositoryId={repositoryId}
          path={selectedPath}
          line={selectedLine}
          base={base}
          side={selectedSide}
          {...(previousPath ? { previousPath } : {})}
          close={closeEvidence}
          mobile
        />
      </Sheet>
    </main>
  );
}
