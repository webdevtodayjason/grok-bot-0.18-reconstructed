// Attestation layer 2: the out-of-band check (docs/JOB-BUS.md section 10.4).
//
// Layer 1 asks this host what its own tools printed. That is a receipt of what ran, not proof that
// anything landed on GitHub: a shell that printed a sha is a shell that printed a sha. So every
// commit and every artifact a reply claims is checked again from here, against api.github.com,
// with the box's own credential (the GITHUB_TOKEN shell secret the `gh` shell tool uses, read
// host-side and never handed to the worker).
//
// Nothing in this module trusts the reply, and nothing in it throws: every failure -- a missing
// credential, a 404, a rate limit, a socket that died -- comes back as an unsupported claim string,
// because "we could not check" and "the claim is false" must both stop a job from reaching `done`.
import { createHash } from "node:crypto";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_PLACEHOLDER = "PLACEHOLDER_LOAD_FROM_DISK";
/** The token never leaves this host, so a slow API must not hold a job's poll loop open. */
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;

export type GitHubFetch = (url: string, init: { readonly headers: Record<string, string>; readonly signal?: AbortSignal }) =>
  Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface GitHubClientDeps {
  /** The GITHUB_TOKEN shell secret, or null when the box has no credential. */
  readonly token: string | null;
  readonly fetchImpl?: GitHubFetch;
  readonly base?: string;
  readonly timeoutMs?: number;
}

export interface GitHubFileFacts {
  readonly size: number;
  readonly sha256: string;
  readonly hasPlaceholder: boolean;
}

/**
 * What a commit is, as GitHub tells it, rather than as the reply describes it. Both fields exist
 * to bind a claimed sha to THIS attempt (section 10.4): `committedAtMs` says when the commit was
 * made, and `files` says what it changed. `files` is null when GitHub did not send the list at all
 * -- it omits it on very large diffs -- which is a check that could not be made, never a pass.
 */
export interface GitHubCommitFacts {
  readonly committedAtMs: number | null;
  readonly files: readonly string[] | null;
}

/** Either the answer, or the `verification:<what>` / claim string that says why there is none. */
export type GitHubCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly unsupported: string };

function defaultFetch(url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) {
  return fetch(url, init) as unknown as ReturnType<GitHubFetch>;
}

export function createGitHubClient(deps: GitHubClientDeps) {
  const base = deps.base ?? GITHUB_API_BASE;
  const call = deps.fetchImpl ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const token = deps.token != null && deps.token.trim().length > 0 ? deps.token.trim() : null;

  /**
   * `what` names the check, not the URL, so an unsupported claim reads
   * `verification:commit:<sha>` rather than leaking a path that carries the token's scope.
   */
  async function get(path: string, what: string): Promise<GitHubCheck<{ status: number; body: string }>> {
    if (token == null) return { ok: false, unsupported: "verification:github_credential_missing" };
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await call(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "titan-job-bus",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
      });
      const body = await response.text().catch(() => "");
      return { ok: true, value: { status: response.status, body } };
    } catch {
      return { ok: false, unsupported: `verification:${what}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    hasCredential: token != null,

    /**
     * The commit exists on the repository, with the two facts that tie it to a job: when it was
     * committed and which files it touched. A 404 is the claim being false, not a check failing.
     */
    async commitFacts(repo: string, sha: string): Promise<GitHubCheck<GitHubCommitFacts>> {
      const answer = await get(`/repos/${repo}/commits/${sha}`, `commit:${sha}`);
      if (!answer.ok) return answer;
      if (answer.value.status === 404 || answer.value.status === 422) return { ok: false, unsupported: `commit:${sha}` };
      if (answer.value.status !== 200) return { ok: false, unsupported: `verification:commit:${sha}` };
      let body: { commit?: { committer?: { date?: unknown }; author?: { date?: unknown } }; files?: unknown };
      try { body = JSON.parse(answer.value.body) as typeof body; }
      catch { return { ok: false, unsupported: `verification:commit:${sha}` }; }
      // The committer date, not the author date: a rebased or cherry-picked commit keeps the
      // author's original timestamp, and the question here is when this sha came into being.
      const date = body.commit?.committer?.date ?? body.commit?.author?.date;
      const committedAtMs = typeof date === "string" ? Date.parse(date) : Number.NaN;
      const files = Array.isArray(body.files)
        ? body.files
          .map((entry) => (entry as { filename?: unknown } | null)?.filename)
          .filter((name): name is string => typeof name === "string")
        : null;
      return {
        ok: true,
        value: { committedAtMs: Number.isFinite(committedAtMs) ? committedAtMs : null, files },
      };
    },

    /**
     * The commit is contained in the branch: comparing branch...sha answers `identical` when they
     * are the same commit and `behind` when the branch has moved past it. `ahead` and `diverged`
     * both mean the sha is not on that branch.
     */
    async commitOnBranch(repo: string, branch: string, sha: string): Promise<GitHubCheck<true>> {
      const what = `commit:${sha}:branch`;
      const answer = await get(`/repos/${repo}/compare/${encodeURIComponent(branch)}...${sha}`, what);
      if (!answer.ok) return answer;
      if (answer.value.status === 404) return { ok: false, unsupported: what };
      if (answer.value.status !== 200) return { ok: false, unsupported: `verification:${what}` };
      let status: unknown;
      try { status = (JSON.parse(answer.value.body) as { status?: unknown }).status; }
      catch { return { ok: false, unsupported: `verification:${what}` }; }
      return status === "identical" || status === "behind" ? { ok: true, value: true } : { ok: false, unsupported: what };
    },

    /** The file's size and content hash at that commit, read from the repository, not the reply. */
    async fileAt(repo: string, path: string, sha: string): Promise<GitHubCheck<GitHubFileFacts>> {
      const what = `artifact:${path}`;
      const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
      const answer = await get(`/repos/${repo}/contents/${encoded}?ref=${sha}`, what);
      if (!answer.ok) return answer;
      if (answer.value.status === 404) return { ok: false, unsupported: what };
      if (answer.value.status !== 200) return { ok: false, unsupported: `verification:${what}` };
      let body: { content?: unknown; encoding?: unknown; type?: unknown };
      try { body = JSON.parse(answer.value.body) as typeof body; }
      catch { return { ok: false, unsupported: `verification:${what}` }; }
      if (body.type !== "file" || typeof body.content !== "string" || body.encoding !== "base64") {
        return { ok: false, unsupported: what };
      }
      const bytes = Buffer.from(body.content, "base64");
      return {
        ok: true,
        value: {
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          hasPlaceholder: bytes.includes(GITHUB_PLACEHOLDER),
        },
      };
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
