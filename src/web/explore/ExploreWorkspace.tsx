import { useEffect, useMemo, useRef, useState } from "react";
import {
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams
} from "react-router-dom";
import { api } from "../api.js";
import { SearchIcon } from "../components/Icons.js";
import { Button, ErrorNotice, LoadingRows, Sheet } from "../components/Ui.js";
import { useAsync } from "../hooks.js";
import { EvidenceInspector } from "../review/ReviewWorkspace.js";
import type { ShellContext } from "../shell/RepositoryShell.js";

interface PathNode {
  name: string;
  path: string;
  file: boolean;
  children: Map<string, PathNode>;
}

function pathTree(paths: string[]): PathNode[] {
  const root = new Map<string, PathNode>();
  for (const path of paths) {
    const segments = path.split("/");
    let children = root;
    let current = "";
    segments.forEach((name, index) => {
      current = current ? `${current}/${name}` : name;
      let node = children.get(name);
      if (!node) {
        node = {
          name,
          path: current,
          file: index === segments.length - 1,
          children: new Map()
        };
        children.set(name, node);
      }
      children = node.children;
    });
  }
  const sorted = (nodes: Map<string, PathNode>): PathNode[] =>
    [...nodes.values()]
      .map((node) => ({
        ...node,
        children: new Map(sorted(node.children).map((child) => [child.name, child]))
      }))
      .sort((left, right) => Number(left.file) - Number(right.file) || left.name.localeCompare(right.name));
  return sorted(root);
}

function PathTree({
  nodes,
  selectedPath,
  choosePath
}: {
  nodes: PathNode[];
  selectedPath: string;
  choosePath: (path: string) => void;
}) {
  return (
    <ul className="path-tree" role="tree">
      {nodes.map((node) => (
        <li key={node.path} role="treeitem">
          {node.file ? (
            <button
              type="button"
              className={node.path === selectedPath ? "selected" : ""}
              onClick={() => choosePath(node.path)}
            >
              {node.name}
            </button>
          ) : (
            <details open={selectedPath.startsWith(`${node.path}/`)}>
              <summary>{node.name}</summary>
              <PathTree
                nodes={[...node.children.values()]}
                selectedPath={selectedPath}
                choosePath={choosePath}
              />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ExploreWorkspace() {
  const { repositoryId = "" } = useParams();
  const { repository } = useOutletContext<ShellContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const selectedLineRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const files = useAsync((signal) => api.files(repositoryId, signal), [repositoryId]);
  const selectedPath = searchParams.get("path") ?? files.data?.files[0] ?? "";
  const selectedLine = Number(searchParams.get("line")) || undefined;
  const source = useAsync(
    (signal) =>
      selectedPath
        ? api.source(repositoryId, selectedPath, signal)
        : Promise.resolve({
            path: "",
            revision: "HEAD",
            offset: 0,
            total: 0,
            truncated: false,
            lines: []
          }),
    [repositoryId, selectedPath]
  );
  const explanation = useAsync(
    (signal) =>
      selectedLine
        ? api.explain(repositoryId, selectedPath, selectedLine, signal)
        : Promise.resolve(undefined),
    [repositoryId, selectedPath, selectedLine]
  );

  useEffect(() => {
    if (!searchParams.get("path") && files.data?.files[0]) {
      const next = new URLSearchParams(searchParams);
      next.set("path", files.data.files[0]);
      setSearchParams(next, { replace: true });
    }
  }, [files.data, searchParams, setSearchParams]);

  const visibleFiles = useMemo(() => {
    const query = filter.toLowerCase().trim();
    return files.data?.files.filter((path) => path.toLowerCase().includes(query)) ?? [];
  }, [files.data, filter]);
  const tree = useMemo(() => pathTree(visibleFiles), [visibleFiles]);

  function choosePath(path: string) {
    const next = new URLSearchParams();
    next.set("path", path);
    setSearchParams(next);
    setFilesOpen(false);
    setEvidenceOpen(false);
  }

  function chooseLine(line: number) {
    const next = new URLSearchParams(searchParams);
    next.set("line", String(line));
    setSearchParams(next);
  }

  function closeEvidence() {
    setEvidenceOpen(false);
    requestAnimationFrame(() => selectedLineRef.current?.focus());
  }

  const fileBrowser = (
    <aside className="explore-files" aria-label="Repository files">
      <label className="file-filter">
        <SearchIcon />
        <span className="sr-only">Search repository paths</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search paths"
        />
      </label>
      <PathTree nodes={tree} selectedPath={selectedPath} choosePath={choosePath} />
    </aside>
  );

  return (
    <main className="explore-workspace">
      <header className="review-summary">
        <nav className="mobile-mode-nav" aria-label="Repository mode">
          <button type="button" onClick={() => navigate(`/r/${repositoryId}/review`)}>Review</button>
          <span aria-current="page">Explore</span>
        </nav>
        <div className="metrics">
          <span>{files.data?.files.length ?? 0} tracked files</span>
          <span>{repository.currentBranch ?? "detached HEAD"}</span>
          <span>Incident archaeology</span>
        </div>
        <Button className="files-button" onClick={() => setFilesOpen(true)}>Browse files</Button>
      </header>
      <div className="explore-regions">
        {fileBrowser}
        <section className="source-region" aria-label="Source file">
          <header className="diff-file-header">
            <h1>{selectedPath || "No tracked files"}</h1>
            <span>{source.data?.total ?? 0} lines</span>
          </header>
          <div className="source-scroll" tabIndex={0}>
            {source.loading ? <LoadingRows count={14} /> : null}
            {source.error ? <ErrorNotice message={source.error.message} retry={source.reload} /> : null}
            {source.data?.lines.map((line) => {
              const selected = line.number === selectedLine;
              return (
                <button
                  type="button"
                  key={line.number}
                  ref={selected ? selectedLineRef : undefined}
                  className={`source-line${selected ? " selected" : ""}`}
                  onClick={() => chooseLine(line.number)}
                  aria-pressed={selected}
                  aria-label={`Line ${line.number}: ${line.text}`}
                >
                  <span>{line.number}</span>
                  <code>{line.text || " "}</code>
                  {selected ? <i className="evidence-seam" aria-hidden="true" /> : null}
                </button>
              );
            })}
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
                <span>Why this line exists</span>
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
        />
      </div>
      <Sheet
        open={filesOpen}
        onOpenChange={setFilesOpen}
        title="Repository files"
        description={repository.repository.name}
        className="file-sheet"
      >
        {fileBrowser}
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
          close={closeEvidence}
          mobile
        />
      </Sheet>
    </main>
  );
}
