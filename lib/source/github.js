'use strict';

const { isHashObject } = require('metautil');
const { isPathInScope } = require('../common/files.js');
const { resource } = require('../common/utilities.js');
const remote = require('./remote.js');
const { RemoteClient, isAbortError, listUrl, parseLinkNext } = remote;
const { commentBody, importedTodo, noteFromLocation } = remote;
const { splitNotes, loadChange, stateIs, loadIssue } = remote;

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const PR_TODO_FILE = 'pull request';
const IMPORT_HOST = 'github';
const GRAPHQL_URL = `${GITHUB_API}/graphql`;
const REVIEW_THREADS_QUERY = resource(__dirname, 'review-threads.graphql')
  .replace(/\s+/g, ' ')
  .trim();

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

const parseGithubUrl = (text, pattern) => {
  if (typeof text !== 'string' || !text) return null;
  const match = pattern.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  if (!match[3]) return { owner, repo, list: true };
  const number = parseInt(match[3], 10);
  if (!Number.isFinite(number) || number < 1) return null;
  return { owner, repo, number };
};

const parseGithubPrUrl = (text) => parseGithubUrl(text, GITHUB_PR_RE);

const parseGithubIssueUrl = (text) => parseGithubUrl(text, GITHUB_ISSUE_RE);

const parseGithubIssueListUrl = (text) =>
  parseGithubUrl(text, GITHUB_ISSUE_LIST_RE);

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

const repositoryApiUrl = ({ owner, repo }) => {
  const name = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return `${GITHUB_API}/repos/${name}`;
};

const prApiUrl = (pr) => `${repositoryApiUrl(pr)}/pulls/${pr.number}`;

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
  const issue = `${repositoryApiUrl(pr)}/issues/${pr.number}`;
  const list = (url) => client.list(listUrl(url), options);
  const [reviewComments, reviews, issueComments, resolvedById] =
    await Promise.all([
      list(`${pull}/comments`),
      list(`${pull}/reviews`),
      list(`${issue}/comments`),
      loadResolvedById(pr, options),
    ]);
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

const issueSite = (issue) => {
  const repository = `${issue.owner}/${issue.repo}`;
  return {
    repository,
    id: `github.com/${repository}/issues`,
    page: `https://github.com/${repository}/issues`,
  };
};

const readIssue = (data) => ({
  number: data.number,
  title: data.title,
  body: data.body,
  author: loginOf(data.user),
  state: data.state,
  url: data['html_url'],
  comments: data.comments,
});

const readIssueComment = (comment) => ({
  reviewer: loginOf(comment.user),
  body: comment.body,
});

const isOpenIssue = (data) => {
  if (!isHashObject(data)) return false;
  if (isHashObject(data['pull_request'])) return false;
  return stateIs(data.state, 'open');
};

const loadGithubIssue = async (issue, options = {}) =>
  loadIssue(issue, options, {
    client: issueClient,
    host: IMPORT_HOST,
    site: issueSite(issue),
    issuesUrl: `${repositoryApiUrl(issue)}/issues`,
    openState: 'open',
    comments: 'comments',
    isOpen: isOpenIssue,
    readIssue,
    readComment: readIssueComment,
  });

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
