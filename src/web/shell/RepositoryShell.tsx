import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import { useState } from "react";
import { api } from "../api.js";
import {
  BranchIcon,
  ChevronIcon,
  MoreIcon,
  RefreshIcon,
  RepositoryIcon
} from "../components/Icons.js";
import {
  Button,
  ErrorNotice,
  IconButton,
  LoadingRows,
  Sheet
} from "../components/Ui.js";
import { useAsync } from "../hooks.js";
import type { CaptureHealth, RepositoryContext } from "../types.js";

export interface ShellContext {
  repository: RepositoryContext;
  capture: CaptureHealth | undefined;
  announce: (message: string) => void;
}

function statusLabel(capture?: CaptureHealth) {
  if (!capture) return "Capture status";
  if (capture.state === "healthy") return "Capture healthy";
  if (capture.state === "restored") return "Capture restored";
  if (capture.state === "pending") return `Capture queued · ${capture.pending}`;
  if (capture.state === "replaying") return `Capture replaying · ${capture.pending}`;
  if (capture.state === "degraded") return "Capture degraded";
  if (capture.state === "interrupted") return "Capture interrupted";
  if (capture.state === "installed") return "Capture installed";
  return "Capture off";
}

export function RepositoryShell({ onLogout }: { onLogout: () => void }) {
  const { repositoryId = "" } = useParams();
  const repository = useAsync(
    (signal) => api.repository(repositoryId, signal),
    [repositoryId]
  );
  const capture = useAsync((signal) => api.captureStatus(signal), [repositoryId]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [announcement, setAnnouncement] = useState("");
  const [controlsOpen, setControlsOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  if (repository.loading && !repository.data) {
    return (
      <main className="shell-loading">
        <div className="wordmark">LINEAGE</div>
        <LoadingRows count={8} />
      </main>
    );
  }
  if (repository.error || !repository.data) {
    return (
      <main className="shell-error">
        <div className="wordmark">LINEAGE</div>
        <ErrorNotice
          message={repository.error?.message ?? "Repository is unavailable."}
          retry={repository.reload}
        />
        <Button onClick={() => navigate("/repositories")}>Back to repositories</Button>
      </main>
    );
  }

  const context = repository.data;
  const base = searchParams.get("base") ?? context.defaultBase ?? "";
  const isReview = location.pathname.endsWith("/review");

  async function switchBranch(branch: string) {
    setAnnouncement(`Switching to ${branch}`);
    try {
      await api.switchBranch(repositoryId, branch);
      if (isReview) {
        const next = new URLSearchParams(searchParams);
        if (base === branch) {
          const fallback = context.branches.find(
            (candidate) => !candidate.remote && candidate.name !== branch
          )?.name;
          if (fallback) next.set("base", fallback);
          else next.delete("base");
        }
        next.delete("file");
        next.delete("line");
        next.delete("side");
        setSearchParams(next);
      }
      repository.reload();
      setAnnouncement(`Switched to ${branch}`);
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : "Branch switch failed.");
    }
  }

  function changeBase(nextBase: string) {
    const next = new URLSearchParams(searchParams);
    next.set("base", nextBase);
    next.delete("file");
    next.delete("line");
    next.delete("side");
    setSearchParams(next);
  }

  async function refresh() {
    setAnnouncement("Refreshing repository and linking sessions");
    try {
      const result = await api.refresh(repositoryId);
      repository.reload();
      capture.reload();
      setAnnouncement(`Refresh complete. ${result.sessions} sessions linked.`);
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : "Refresh failed.");
    }
  }

  async function logout() {
    await api.logout();
    onLogout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="command-rail">
        <button
          type="button"
          className="wordmark wordmark--button"
          onClick={() => navigate("/repositories")}
          aria-label="All repositories"
        >
          LINEAGE
        </button>
        <label className="rail-select rail-select--repository">
          <RepositoryIcon />
          <span className="sr-only">Repository</span>
          <select
            value={context.repository.id}
            onChange={(event) => navigate(`/r/${event.target.value}/review`)}
          >
            <option value={context.repository.id}>{context.repository.name}</option>
          </select>
          <ChevronIcon />
        </label>
        <label className="rail-select rail-select--branch">
          <BranchIcon />
          <span className="sr-only">Current branch</span>
          <select
            value={context.currentBranch ?? ""}
            onChange={(event) => void switchBranch(event.target.value)}
          >
            {context.branches.map((branch) => (
              <option key={branch.fullName} value={branch.name}>
                {branch.name}{branch.remote ? " · track remote" : ""}
              </option>
            ))}
          </select>
          <ChevronIcon />
        </label>
        {isReview ? (
          <label className="rail-select rail-select--base">
            <span>Base</span>
            <select
              value={base}
              onChange={(event) => changeBase(event.target.value)}
            >
              {context.branches
                .filter((branch) => branch.name !== context.currentBranch)
                .map((branch) => (
                  <option key={branch.fullName} value={branch.name}>{branch.name}</option>
                ))}
            </select>
            <ChevronIcon />
          </label>
        ) : null}
        <nav className="mode-nav" aria-label="Repository mode">
          <NavLink to={`/r/${repositoryId}/review${base ? `?base=${encodeURIComponent(base)}` : ""}`}>
            Review
          </NavLink>
          <NavLink to={`/r/${repositoryId}/explore`}>Explore</NavLink>
        </nav>
        <NavLink
          className={`capture-state capture-state--${capture.data?.state ?? "off"}`}
          to={`/r/${repositoryId}/capture`}
        >
          <span aria-hidden="true" />
          {statusLabel(capture.data)}
        </NavLink>
        <IconButton label="Refresh repository" onClick={() => void refresh()}>
          <RefreshIcon />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label="Repository actions">
              <MoreIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={8}>
              <DropdownMenu.Item onSelect={() => navigate("/repositories")}>
                All repositories
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => navigate(`/r/${repositoryId}/sessions`)}>
                Sessions
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => navigate(`/r/${repositoryId}/capture`)}>
                Capture setup
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mobile-menu-only" />
              <DropdownMenu.Item
                className="mobile-menu-only"
                onSelect={() => setControlsOpen(true)}
              >
                Branch and base
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="mobile-menu-only"
                onSelect={() => void refresh()}
              >
                Refresh repository
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => {
                  void api
                    .download(api.exportUrl(repositoryId, "agent-trace"))
                    .catch(() => undefined);
                }}
              >
                Export Agent Trace
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => void logout()}>Log out</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <div className="mobile-context">
        <span>{context.repository.name}</span>
        <span>·</span>
        <span>{context.currentBranch}</span>
        {base ? (
          <>
            <span className="mobile-context__base">Base</span>
            <span>{base}</span>
          </>
        ) : null}
      </div>
      <Outlet
        context={{
          repository: context,
          capture: capture.data,
          announce: setAnnouncement
        } satisfies ShellContext}
      />
      <Sheet
        open={controlsOpen}
        onOpenChange={setControlsOpen}
        title="Repository controls"
        description="Switch working context or refresh linked provenance."
        className="repository-controls-sheet"
      >
        <div className="repository-controls">
          <label>
            <span>Current branch</span>
            <select
              value={context.currentBranch ?? ""}
              onChange={(event) => void switchBranch(event.target.value)}
            >
              {context.branches.map((branch) => (
                <option key={branch.fullName} value={branch.name}>
                  {branch.name}{branch.remote ? " · track remote" : ""}
                </option>
              ))}
            </select>
          </label>
          {isReview ? (
            <label>
              <span>Comparison base</span>
              <select value={base} onChange={(event) => changeBase(event.target.value)}>
                {context.branches
                  .filter((branch) => branch.name !== context.currentBranch)
                  .map((branch) => (
                    <option key={branch.fullName} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          <Button
            onClick={() => {
              setControlsOpen(false);
              void refresh();
            }}
          >
            <RefreshIcon />
            Refresh repository
          </Button>
        </div>
      </Sheet>
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}
