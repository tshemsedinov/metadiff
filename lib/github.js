'use strict';

const files = require('./files.js');
const { isPathInScope } = files;
const remote = require('./remote.js');
const { isRecord, isAbortError } = remote;
const { createClient, listUrl, parseLinkNext } = remote;
const { filterChangeFiles, changeFiles, loadChange } = remote;
const { importedText, importedTodo, noteFromLocation } = remote;

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const PR_TODO_FILE = 'pull request';
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

const asRecord = (value) => (isRecord(value) ? value : {});

const parseGithubPrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITHUB_PR_RE.exec(text.trim());
  if (!match) return null;
  const owner = match[1];
  const rawRepo = match[2];
  const repo = rawRepo.replace(/\.git$/i, '');
  const number = parseInt(match[3], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!owner || !repo || !hasNumber) return null;
  return { owner, repo, number };
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

const client = createClient({
  name: 'GitHub',
  subject: 'pull request',
  headers: githubHeaders,
  nextPage: parseLinkNext,
});
const {
  request: requestGithub,
  list: requestGithubList,
  parseJson: parseGithubJson,
} = client;

const requestGraphql = async (query, variables, options) => {
  const payload = JSON.stringify({ query, variables });
  const page = await requestGithub(GRAPHQL_URL, {
    ...options,
    method: 'POST',
    accept: JSON_ACCEPT,
    contentType: 'application/json',
    body: payload,
  });
  return parseGithubJson(page.body, 'GraphQL payload');
};

const prApiUrl = (pr) => {
  const owner = encodeURIComponent(pr.owner);
  const repo = encodeURIComponent(pr.repo);
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pr.number}`;
};

const discussionUrls = (pr) => {
  const pull = prApiUrl(pr);
  const issue = pull.replace('/pulls/', '/issues/');
  return {
    reviewComments: listUrl(`${pull}/comments`),
    reviews: listUrl(`${pull}/reviews`),
    issueComments: listUrl(`${issue}/comments`),
  };
};

const readLogin = (user) => {
  if (!isRecord(user)) return '';
  return user.login || '';
};

const readRef = (side) => {
  if (!isRecord(side)) return '';
  return side.ref || '';
};

const readRepoName = (data, pr) => {
  const base = isRecord(data.base) ? data.base : null;
  const repo = base && isRecord(base.repo) ? base.repo : null;
  const fromBase = repo && repo['full_name'];
  if (fromBase) return fromBase;
  return `${pr.owner}/${pr.repo}`;
};

const toChange = (pr, data, items) => {
  const number = data.number || pr.number;
  const repository = readRepoName(data, pr);
  const title = data.title || '';
  const author = readLogin(data.user);
  const files = changeFiles(items);
  const base = readRef(data.base);
  const head = readRef(data.head);
  const fallbackUrl = `https://github.com/${repository}/pull/${number}`;
  const url = data['html_url'] || fallbackUrl;
  const id = `github.com/${repository}/pull/${number}`;
  return {
    id,
    source: 'pr',
    title,
    author,
    files,
    status: 'reviewing',
    base,
    head,
    url,
    repository,
    number,
  };
};

const readCommentBody = (value) => `${value ?? ''}`.trim();

const reviewerOf = (record) => {
  const login = readLogin(record && record.user);
  return login || 'unknown';
};

const formatImportedText = (entry) => importedText(entry, IMPORT_HOST);

const commentLine = (comment) => {
  const side = comment.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const raw = comment.line ?? comment['original_line'];
  const line = Number(raw);
  if (!Number.isFinite(line) || line < 1) return { side, line: 0 };
  return { side, line };
};

const resolvedOf = (resolvedById, id) => {
  const commentId = Number(id);
  if (!Number.isFinite(commentId) || !resolvedById.has(commentId)) {
    return null;
  }
  return resolvedById.get(commentId);
};

const reviewCommentToNote = (comment, items, resolvedById, paths) => {
  if (!isRecord(comment)) return null;
  const body = readCommentBody(comment.body);
  if (!body) return null;
  const path = comment.path || '';
  if (path && !isPathInScope(path, paths)) return null;
  const { side, line } = commentLine(comment);
  const resolved = resolvedOf(resolvedById, comment.id);
  const entry = {
    reviewer: reviewerOf(comment),
    body,
    resolved,
  };
  const subject = comment['subject_type'] || 'line';
  if (subject === 'file') {
    if (path) return importedTodo(path, entry, IMPORT_HOST);
    return importedTodo(PR_TODO_FILE, entry, IMPORT_HOST);
  }
  return noteFromLocation(
    items,
    { path, line, side },
    entry,
    IMPORT_HOST,
    PR_TODO_FILE,
  );
};

const summaryToTodo = (record) => {
  if (!isRecord(record)) return null;
  const body = readCommentBody(record.body);
  if (!body) return null;
  return importedTodo(
    PR_TODO_FILE,
    {
      reviewer: reviewerOf(record),
      body,
    },
    IMPORT_HOST,
  );
};

const discussionToNotes = (discussion, items, paths = []) => {
  const feedback = [];
  const todos = [];
  const resolvedById = discussion.resolvedById ?? new Map();
  const reviewComments = discussion.reviewComments ?? [];
  for (const comment of reviewComments) {
    const note = reviewCommentToNote(comment, items, resolvedById, paths);
    if (!note) continue;
    if (note.kind === 'feedback') feedback.push(note);
    else todos.push(note);
  }
  const reviews = discussion.reviews ?? [];
  for (const review of reviews) {
    const todo = summaryToTodo(review);
    if (todo) todos.push(todo);
  }
  const issueComments = discussion.issueComments ?? [];
  for (const comment of issueComments) {
    const todo = summaryToTodo(comment);
    if (todo) todos.push(todo);
  }
  return { feedback, todos };
};

const loadReviewThreads = async (pr, options) => {
  const threads = [];
  let after = null;
  for (;;) {
    const payload = await requestGraphql(
      REVIEW_THREADS_QUERY,
      {
        owner: pr.owner,
        name: pr.repo,
        number: pr.number,
        after,
      },
      options,
    );
    if (!isRecord(payload.data)) return threads;
    const data = payload.data;
    const repository = asRecord(data.repository);
    const pullRequest = asRecord(repository.pullRequest);
    const reviewThreads = asRecord(pullRequest.reviewThreads);
    const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
    for (const thread of nodes) threads.push(thread);
    const pageInfo = asRecord(reviewThreads.pageInfo);
    if (!pageInfo.hasNextPage) return threads;
    const cursor = pageInfo.endCursor || null;
    if (!cursor || cursor === after) return threads;
    after = cursor;
  }
};

const threadComments = (thread) => {
  if (!isRecord(thread)) return [];
  const comments = thread.comments;
  if (isRecord(comments) && Array.isArray(comments.nodes)) {
    return comments.nodes;
  }
  return [];
};

const loadResolvedById = async (pr, options) => {
  const resolved = new Map();
  try {
    const threads = await loadReviewThreads(pr, options);
    for (const thread of threads) {
      const isResolved = thread.isResolved === true;
      for (const comment of threadComments(thread)) {
        if (!isRecord(comment)) continue;
        const id = Number(comment.databaseId);
        if (!Number.isFinite(id)) continue;
        resolved.set(id, isResolved);
      }
    }
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    // ignore: resolved state is optional
  }
  return resolved;
};

const loadDiscussion = async (pr, options) => {
  const urls = discussionUrls(pr);
  const reviewComments = await requestGithubList(urls.reviewComments, options);
  const reviews = await requestGithubList(urls.reviews, options);
  const issueComments = await requestGithubList(urls.issueComments, options);
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

module.exports = {
  parseGithubPrUrl,
  githubToken,
  filterChangeFiles,
  prApiUrl,
  formatImportedText,
  discussionToNotes,
  loadPullRequest,
};
