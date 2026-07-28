import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { RepositoryIcon } from "../components/Icons.js";
import { Button, ErrorNotice, LoadingRows } from "../components/Ui.js";
import { useAsync } from "../hooks.js";

export function RepositoriesPage() {
  const repositories = useAsync((signal) => api.repositories(signal), []);
  const [path, setPath] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [working, setWorking] = useState("");
  const navigate = useNavigate();

  async function add(event: FormEvent) {
    event.preventDefault();
    setWorking("add");
    setMutationError("");
    try {
      const result = await api.addRepository(path.trim());
      navigate(`/r/${result.repository.id}/review`);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Repository could not be opened.");
    } finally {
      setWorking("");
    }
  }

  async function demo() {
    setWorking("demo");
    setMutationError("");
    try {
      const result = await api.createDemo();
      navigate(`/r/${result.repository.id}/review`);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Demo could not be created.");
    } finally {
      setWorking("");
    }
  }

  async function forget(id: string) {
    setWorking(id);
    setMutationError("");
    try {
      await api.removeRepository(id);
      repositories.reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Repository could not be forgotten.");
    } finally {
      setWorking("");
    }
  }

  return (
    <main className="repositories">
      <header className="repositories__header">
        <div>
          <div className="wordmark">LINEAGE</div>
          <h1>Repositories</h1>
        </div>
        <p>Open once. Review from this machine whenever you return.</p>
      </header>

      <section className="repository-open" aria-labelledby="open-repository">
        <h2 id="open-repository">Open a local Git repository</h2>
        <form onSubmit={add}>
          <label htmlFor="repository-path">Path on this server</label>
          <div className="field-action">
            <input
              id="repository-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/dean/project"
              required
            />
            <Button variant="primary" type="submit" disabled={working === "add"}>
              {working === "add" ? "Opening…" : "Open repository"}
            </Button>
          </div>
          <p>
            Paths must be inside an operator-approved root. Nothing is uploaded
            or copied.
          </p>
        </form>
        <Button onClick={demo} disabled={working === "demo"}>
          {working === "demo" ? "Resetting demo…" : "Open demo repository"}
        </Button>
      </section>

      {mutationError ? <ErrorNotice message={mutationError} /> : null}

      <section className="remembered" aria-labelledby="remembered-title">
        <header>
          <h2 id="remembered-title">Remembered on this machine</h2>
          <span>{repositories.data?.repositories.length ?? 0}</span>
        </header>
        {repositories.loading ? <LoadingRows count={4} /> : null}
        {repositories.error ? (
          <ErrorNotice message={repositories.error.message} retry={repositories.reload} />
        ) : null}
        {!repositories.loading && repositories.data?.repositories.length === 0 ? (
          <div className="empty-state">
            <RepositoryIcon />
            <h3>No repositories yet</h3>
            <p>Open a Git root above, or use the real demo to inspect the review flow.</p>
          </div>
        ) : null}
        <div className="repository-list">
          {repositories.data?.repositories.map((repository) => (
            <article key={repository.id} className="repository-row">
              <button
                type="button"
                className="repository-row__open"
                onClick={() => navigate(`/r/${repository.id}/review`)}
                disabled={!repository.available}
              >
                <RepositoryIcon />
                <span>
                  <strong>{repository.name}</strong>
                  <small>{repository.root}</small>
                  {!repository.available ? <em>{repository.reason}</em> : null}
                </span>
              </button>
              <Button
                variant="danger"
                onClick={() => void forget(repository.id)}
                disabled={working === repository.id}
              >
                Forget
              </Button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

