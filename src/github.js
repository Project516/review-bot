import { createSign } from "node:crypto";

const API = "https://api.github.com";

export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${sig}`;
}

export async function installationToken(appId, privateKey, installationId) {
  const app = client(appJwt(appId, privateKey));
  const res = await app.post(`/app/installations/${installationId}/access_tokens`);
  return res.token;
}

// appSlug is the App's own login, without the "[bot]" suffix REST puts on it.
// GraphQL reports a bot author's login as the bare slug, so callers that
// compare against both APIs need this to build "${slug}[bot]" for REST.
export async function appSlug(appId, privateKey) {
  const app = client(appJwt(appId, privateKey));
  const res = await app.get("/app");
  return res.slug;
}

export class GitHubError extends Error {
  constructor(status, method, path, body) {
    super(`GitHub ${method} ${path} -> ${status}: ${body}`);
    this.status = status;
  }
}

// client returns a tiny REST and GraphQL helper bound to one token.
export function client(token) {
  const headers = (body) => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "review-bot",
    "x-github-api-version": "2022-11-28",
    ...(body ? { "content-type": "application/json" } : {}),
  });
  async function call(method, path, body) {
    const url = path.startsWith("http") ? path : API + path;
    const res = await fetch(url, { method, headers: headers(body), body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new GitHubError(res.status, method, path, await res.text());
    return { data: res.status === 204 ? null : await res.json(), next: nextLink(res.headers.get("link")) };
  }
  return {
    get: async (path) => (await call("GET", path)).data,
    post: async (path, body) => (await call("POST", path, body)).data,
    async paginate(path) {
      const out = [];
      let url = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
      while (url) {
        const { data, next } = await call("GET", url);
        out.push(...data);
        url = next;
      }
      return out;
    },
    async graphql(query, variables) {
      const res = await fetch(`${API}/graphql`, { method: "POST", headers: headers(true), body: JSON.stringify({ query, variables }) });
      const body = await res.text();
      if (!res.ok) throw new GitHubError(res.status, "POST", "/graphql", body);
      const data = JSON.parse(body);
      if (data.errors) throw new GitHubError(res.status, "POST", "/graphql", JSON.stringify(data.errors));
      return data.data;
    },
  };
}

export function nextLink(header) {
  if (!header) return null;
  const m = header.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}
