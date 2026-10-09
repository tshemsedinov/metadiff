'use strict';

const { isHashObject } = require('metautil');
const { isPathInScope } = require('./files.js');
const remote = require('./remote.js');
const { RemoteClient, isAbortError, listUrl, parseLinkNext } = remote;
const { commentBody, importedTodo, noteFromLocation } = remote;
const { splitNotes, loadChange, issueText, issueTodo } = remote;

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const PR_TODO_FILE = 'pull request';
const ISSUE_TODO_FILE = 'issue';
const IMPORT_HOST = 'github';
const GRAPHQL_URL = `${GITHUB_API}/graphql`;
const REVIEW_THREADS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $after: String) {' +
  ' repository(owner: $owner, name: $name) {' +
  ' pullRequest(number: $number) {' +
  ' reviewThreads(first: 100, after: $after) {' +
  ' pageInfo { hasNextPage endCursor }' +
  ' nodes { isResolved comments(first: 100) { nodes { databaseId } } }' +
  ' } } } }';

const GITHUB_PR_RE = new RegExp(
  String.raw`^(?:https?://)?(?:www\.)?github\.com/` +
    String.raw`([^/?#]+)/([^/?#]+)/pull/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:files|commits|checks|changes)?)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const GITHUB_ISSUE_RE = new RegExp(
  String.raw`^(?:https?://)?(?:www\.)?github\.com/` +
    String.raw`([^/?#]+)/([^/?#]+)/issues/(\d+)` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const GITHUB_ISSUE_LIST_RE = new RegExp(
  String.raw`^(?:https?://)?(?:www\.)?github\.com/` +
    String.raw`([^/?#]+)/([^/?#]+?)(?:\.git)?` +
    String.raw`(?:/issues)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const parseGithubPrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITHUB_PR_RE.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  const number = parseInt(match[3], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!owner || !repo || !hasNumber) return null;
  return { owner, repo, number };
};

const parseGithubIssueUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITHUB_ISSUE_RE.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  const number = parseInt(match[3], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!owner || !repo || !hasNumber) return null;
  return { owner, repo, number };
};

const parseGithubIssueListUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITHUB_ISSUE_LIST_RE.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo, list: true };
};

const githubToken = (env) => {
  const from = env ?? process.env;
  return from.GITHUB_TOKEN || from.GH_TOKEN || '';
};

const githubHeaders = (token, accept = JSON_ACCEPT) => {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
};

const client = new RemoteClient({
  name: 'GitHub',
  subject: 'pull request',
  headers: githubHeaders,
  nextPage: parseLinkNext,
});

const issueClient = new RemoteClient({
  name: 'GitHub',
  subject: 'issue',
  headers: githubHeaders,
  nextPage: parseLinkNext,
});

const prApiUrl = (pr) => {
  const owner = encodeURIComponent(pr.owner);
  const repo = encodeURIComponent(pr.repo);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pr.number}`;
};

const loginOf = (user) => user?.login || '';

const toChange = (pr, data) => {
  const number = data.number || pr.number;
  const fullName = data.base?.repo?.['full_name'];
  const repository = fullName || `${pr.owner}/${pr.repo}`;
  const fallbackUrl = `https://github.com/${repository}/pull/${number}`;
  return {
    id: `github.com/${repository}/pull/${number}`,
    source: 'pr',
    title: data.title || '',
    author: loginOf(data.user),
    base: data.base?.ref || '',
    head: data.head?.ref || '',
    url: data['html_url'] || fallbackUrl,
    repository,
    number,
  };
};

const commentLine = (comment) => {
  const side = comment.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const line = Number(comment.line ?? comment['original_line']);
  if (!Number.isFinite(line) || line < 1) return { side, line: 0 };
  return { side, line };
};

const reviewCommentToNote = (comment, items, resolvedById, paths) => {
  if (!isHashObject(comment)) return null;
  const body = commentBody(comment.body);
  if (!body) return null;
  const path = comment.path || '';
  if (path && !isPathInScope(path, paths)) return null;
  const resolved = resolvedById.get(Number(comment.id)) ?? null;
  const entry = { reviewer: loginOf(comment.user), body, resolved };
  if (comment['subject_type'] === 'file') {
    return importedTodo(path || PR_TODO_FILE, entry, IMPORT_HOST);
  }
  const { side, line } = commentLine(comment);
  const loc = { path, line, side };
  return noteFromLocation(items, loc, entry, IMPORT_HOST, PR_TODO_FILE);
};

const summaryToTodo = (record) => {
  if (!isHashObject(record)) return null;
  const body = commentBody(record.body);
  if (!body) return null;
  const entry = { reviewer: loginOf(record.user), body };
  return importedTodo(PR_TODO_FILE, entry, IMPORT_HOST);
};

const discussionToNotes = (discussion, items, paths = []) => {
  const resolvedById = discussion.resolvedById ?? new Map();
  const comments = discussion.reviewComments ?? [];
  const reviews = discussion.reviews ?? [];
  const issueComments = discussion.issueComments ?? [];
  return splitNotes([
    ...comments.map((comment) =>
      reviewCommentToNote(comment, items, resolvedById, paths),
    ),
    ...[...reviews, ...issueComments].map((record) => summaryToTodo(record)),
  ]);
};

const requestThreads = async (variables, options) => {
  const page = await client.request(GRAPHQL_URL, {
    ...options,
    method: 'POST',
    accept: JSON_ACCEPT,
    contentType: 'application/json',
    body: JSON.stringify({ query: REVIEW_THREADS_QUERY, variables }),
  });
  const payload = client.parseJson(page.body, 'GraphQL payload');
  return payload.data?.repository?.pullRequest?.reviewThreads;
};

const loadReviewThreads = async (pr, options) => {
  const threads = [];
  let after = null;
  for (;;) {
    const variables = { owner: pr.owner, name: pr.repo, number: pr.number };
    const page = await requestThreads({ ...variables, after }, options);
    if (Array.isArray(page?.nodes)) threads.push(...page.nodes);
    const pageInfo = page?.pageInfo;
    const cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    if (!cursor || cursor === after) return threads;
    after = cursor;
  }
};

const loadResolvedById = async (pr, options) => {
  const resolved = new Map();
  try {
    for (const thread of await loadReviewThreads(pr, options)) {
      const comments = thread?.comments?.nodes;
      if (!Array.isArray(comments)) continue;
      for (const comment of comments) {
        const id = Number(comment?.databaseId);
        if (Number.isFinite(id)) resolved.set(id, thread.isResolved === true);
      }
    }
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
  }
  return resolved;
};

const loadDiscussion = async (pr, options) => {
  const pull = prApiUrl(pr);
  const issue = pull.replace('/pulls/', '/issues/');
  const list = (url) => client.list(listUrl(url), options);
  const reviewComments = await list(`${pull}/comments`);
  const reviews = await list(`${pull}/reviews`);
  const issueComments = await list(`${issue}/comments`);
  const resolvedById = await loadResolvedById(pr, options);
  return { reviewComments, reviews, issueComments, resolvedById };
};

const loadPullRequest = (pr, options = {}) =>
  loadChange(pr, options, {
    client,
    url: prApiUrl(pr),
    diffAccept: DIFF_ACCEPT,
    prefix: '#',
    toChange,
    loadDiscussion,
    discussionToNotes,
  });

const issueApiUrl = (issue) => {
  const owner = encodeURIComponent(issue.owner);
  const repo = encodeURIComponent(issue.repo);
  return `${GITHUB_API}/repos/${owner}/${repo}/issues/${issue.number}`;
};

const toIssueChange = (issue, data) => {
  const number = data.number || issue.number;
  const repository = `${issue.owner}/${issue.repo}`;
  const fallbackUrl = `https://github.com/${repository}/issues/${number}`;
  return {
    id: `github.com/${repository}/issues/${number}`,
    source: 'issue',
    title: data.title || '',
    author: loginOf(data.user),
    base: '',
    head: '',
    url: data['html_url'] || fallbackUrl,
    repository,
    number,
  };
};

const issueClosed = (state) => `${state ?? ''}`.toLowerCase() === 'closed';

const githubIssuePage = (issue, data) => {
  if (data['html_url']) return data['html_url'];
  const number = data.number || issue.number;
  const repository = `${issue.owner}/${issue.repo}`;
  if (!number) return '';
  return `https://github.com/${repository}/issues/${number}`;
};

const githubIssueNotes = (issue, data, comments) => {
  const text = issueText(data.title, data.body);
  const main = text
    ? issueTodo(
        ISSUE_TODO_FILE,
        {
          reviewer: loginOf(data.user),
          body: text,
          resolved: issueClosed(data.state),
          url: githubIssuePage(issue, data),
        },
        IMPORT_HOST,
      )
    : null;
  const rest = comments.map((comment) => {
    const body = commentBody(comment.body);
    if (!body) return null;
    return issueTodo(
      ISSUE_TODO_FILE,
      { reviewer: loginOf(comment.user), body },
      IMPORT_HOST,
    );
  });
  return splitNotes([main, ...rest]);
};

const issueRequest = (options) => ({
  fetch: options.fetch ?? globalThis.fetch,
  token: options.token ?? '',
  retry: options.retry ?? {},
  signal: options.signal,
});

const isOpenGithubIssue = (data) => {
  if (!isHashObject(data)) return false;
  if (isHashObject(data['pull_request'])) return false;
  return `${data.state ?? ''}`.toLowerCase() === 'open';
};

const githubIssuesUrl = (issue) => {
  const owner = encodeURIComponent(issue.owner);
  const repo = encodeURIComponent(issue.repo);
  return `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open`;
};

const githubCommentUrl = (issue, number) => {
  const owner = encodeURIComponent(issue.owner);
  const repo = encodeURIComponent(issue.repo);
  const base = `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`;
  return listUrl(`${base}/comments`);
};

const tasksFromGithubIssues = async (issue, rows, request) => {
  const tasks = [];
  for (const data of rows) {
    const comments = await issueClient.list(
      githubCommentUrl(issue, data.number),
      request,
    );
    const notes = githubIssueNotes(issue, data, comments);
    tasks.push(...notes.tasks);
  }
  return tasks;
};

const listIssueChange = (repository, url) => ({
  id: `github.com/${repository}/issues`,
  source: 'issue',
  title: '',
  author: '',
  base: '',
  head: '',
  url,
  repository,
  number: 0,
});

const loadGithubIssueList = async (issue, options) => {
  const request = issueRequest(options);
  const list = listUrl(githubIssuesUrl(issue));
  const rows = await issueClient.list(list, request);
  const open = rows.filter(isOpenGithubIssue);
  const tasks = await tasksFromGithubIssues(issue, open, request);
  const repository = `${issue.owner}/${issue.repo}`;
  const url = `https://github.com/${repository}/issues`;
  return {
    top: options.cwd,
    items: [],
    sourceLabel: repository,
    change: listIssueChange(repository, url),
    imported: { feedback: [], tasks },
  };
};

const loadGithubIssue = async (issue, options = {}) => {
  if (issue.list) return loadGithubIssueList(issue, options);
  const request = issueRequest(options);
  const url = issueApiUrl(issue);
  const page = await issueClient.request(url, request);
  const data = issueClient.parseJson(page.body, 'issue payload');
  const comments = await issueClient.list(listUrl(`${url}/comments`), request);
  const number = data.number || issue.number;
  return {
    top: options.cwd,
    items: [],
    sourceLabel: `#${number}`,
    change: toIssueChange(issue, data),
    imported: githubIssueNotes(issue, data, comments),
  };
};

module.exports = {
  parseGithubPrUrl,
  parseGithubIssueUrl,
  parseGithubIssueListUrl,
  githubToken,
  prApiUrl,
  discussionToNotes,
  loadPullRequest,
  loadGithubIssue,
};
