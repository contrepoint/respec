// @ts-check
import { fetchAndCache } from "./utils.js";
import { pub } from "./pubsubhub.js";
export const name = "core/github-api";

export function githubRequestHeaders(conf) {
  const { githubUser, githubToken } = conf;
  const headers = {
    // Get back HTML content instead of markdown
    // See: https://developer.github.com/v3/media/
    Accept: "application/vnd.github.v3.html+json",
  };
  if (githubUser && githubToken) {
    const credentials = btoa(`${githubUser}:${githubToken}`);
    const Authorization = `Basic ${credentials}`;
    Object.assign(headers, { Authorization });
  } else if (githubToken) {
    const Authorization = `token ${githubToken}`;
    Object.assign(headers, { Authorization });
  }
  return headers;
}

let warned = false;
export function checkLimitReached(response) {
  const { headers, status } = response;
  if (status === 403 && headers.get("X-RateLimit-Remaining") === "0") {
    if (!warned) {
      warned = true;
      const msg = `You have run out of github requests. Some github assets will not show up.`;
      pub("warning", msg);
    }
    return true;
  }
  return false;
}

export async function fetchAndStoreGithubIssues(conf) {
  const { githubAPI } = conf;
  /** @type {NodeListOf<HTMLElement>} */
  const specIssues = document.querySelectorAll(".issue[data-number]");
  const issuePromises = [...specIssues]
    .map(elem => Number.parseInt(elem.dataset.number, 10))
    .filter(issueNumber => issueNumber)
    .map(async issueNumber => {
      const issueURL = `${githubAPI}/issues/${issueNumber}`;
      const headers = githubRequestHeaders(conf);
      const request = new Request(issueURL, {
        mode: "cors",
        referrerPolicy: "no-referrer",
        headers,
      });
      const response = await fetchAndCache(request);
      return processResponse(response, issueNumber);
    });
  const issues = await Promise.all(issuePromises);
  return new Map(issues);
}

/**
 * @typedef {object} GitHubLabel
 * @property {string} color
 * @property {string} name
 *
 * @typedef {object} GitHubIssue
 * @property {string} title
 * @property {number} number
 * @property {string} state
 * @property {string} message
 * @property {string} [body_html]
 * @property {GitHubLabel[]} [labels]
 *
 * @param {Response} response
 * @param {number} issueNumber
 * @returns {Promise<[number, GitHubIssue]>}
 */
async function processResponse(response, issueNumber) {
  // "message" is always error message from GitHub
  checkLimitReached(response);
  const issue = { title: "", number: issueNumber, state: "", message: "" };
  try {
    const json = await response.json();
    Object.assign(issue, json);
  } catch (err) {
    console.error(err);
    issue.message = `Error JSON parsing issue #${issueNumber} from GitHub.`;
  }
  if (!response.ok || issue.message) {
    const msg = `Error fetching issue #${issueNumber} from GitHub. ${issue.message} (HTTP Status ${response.status}).`;
    pub("error", msg);
  }
  return [issueNumber, issue];
}

function findNext(header) {
  // Finds the next URL of paginated resources which
  // is available in the Link header. Link headers look like this:
  // Link: <url1>; rel="next", <url2>; rel="foo"; bar="baz"
  // More info here: https://developer.github.com/v3/#link-header
  const m = (header || "").match(/<([^>]+)>\s*;\s*rel="next"/);
  return m ? m[1] : null;
}

export async function fetchAll(url, headers, output = []) {
  const urlObj = new URL(url);
  if (urlObj.searchParams && !urlObj.searchParams.has("per_page")) {
    urlObj.searchParams.append("per_page", "100");
  }
  const request = new Request(urlObj.toString(), { headers });
  request.headers.set("Accept", "application/vnd.github.v3+json");
  const response = await fetch(request);
  const json = await response.json();
  if (Array.isArray(json)) {
    output.push(...json);
  }
  const next = findNext(response.headers.get("Link"));
  return next ? fetchAll(next, headers, output) : output;
}
