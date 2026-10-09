'use strict';

const { isHashObject } = require('metautil');
const { isPathInScope } = require('./files.js');
const remote = require('./remote.js');
const { RemoteClient, listUrl, parseNextPage, commentBody } = remote;
const { importedTodo, noteFromLocation, splitNotes, loadChange } = remote;
const { issueText, issueTodo } = remote;

const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/json';
const DIFF_ACCEPT = 'text/plain';
const MR_TODO_FILE = 'merge request';
const ISSUE_TODO_FILE = 'issue';
const IMPORT_HOST = 'gitlab';
const NO_LINE = { side: 'RIGHT', line: 0 };

const GITLAB_MR_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/merge_requests/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:diffs|commits|pipelines|changes)?)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const GITLAB_ISSUE_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/issues/(\d+)` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const parseGitlabMrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_MR_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  const project = match[3].replace(/\.git$/i, '');
  const number = parseInt(match[4], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!host || !project || !hasNumber) return null;
  return { host, project, number, origin: `${scheme}://${host}` };
};

const GITLAB_HOST_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+\.[^/?#]+)/([^?#]+)`,
  'i',
);

const parseGitlabIssueUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_ISSUE_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  const project = match[3].replace(/\.git$/i, '');
  const number = parseInt(match[4], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!host || !project || !hasNumber) return null;
  if (host.toLowerCase() === 'github.com') return null;
  return { host, project, number, origin: `${scheme}://${host}` };
};

const parseGitlabIssueListUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_HOST_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  if (!host || host.toLowerCase() === 'github.com') return null;
  let path = match[3].replace(/\/+$/, '');
  if (/\/issues\/\d+/.test(path)) return null;
  const listed = /(?:\/-)?\/issues$/.test(path);
  if (listed) path = path.replace(/(?:\/-)?\/issues$/, '');
  else if (path.includes('/-/')) return null;
  path = path.replace(/\.git$/i, '');
  if (!path.includes('/')) return null;
  return { host, project: path, origin: `${scheme}://${host}`, list: true };
};

const gitlabToken = (env) => {
  const from = env ?? process.env;
  return from.GITLAB_TOKEN || from.GL_TOKEN || '';
};

const gitlabHeaders = (token, accept = JSON_ACCEPT) => {
  const headers = { Accept: accept, 'User-Agent': USER_AGENT };
  if (!token) return headers;
  return { ...headers, 'PRIVATE-TOKEN': token };
};

const client = new RemoteClient({
  name: 'GitLab',
  subject: 'merge request',
  headers: gitlabHeaders,
  nextPage: parseNextPage,
  errorFields: ['message', 'error'],
  limitStatus: 429,
});

const issueClient = new RemoteClient({
  name: 'GitLab',
  subject: 'issue',
  headers: gitlabHeaders,
  nextPage: parseNextPage,
  errorFields: ['message', 'error'],
  limitStatus: 429,
});

const mrApiUrl = (mr) => {
  const project = encodeURIComponent(mr.project);
  return `${mr.origin}/api/v4/projects/${project}/merge_requests/${mr.number}`;
};

const usernameOf = (user) => user?.username || '';

const readProject = (data, mr) => {
  const full = data.references?.full;
  const cut = typeof full === 'string' ? full.lastIndexOf('!') : -1;
  return cut > 0 ? full.slice(0, cut) : mr.project;
};

const toChange = (mr, data) => {
  const number = data.iid || mr.number;
  const repository = readProject(data, mr);
  const fallbackUrl = `${mr.origin}/${repository}/-/merge_requests/${number}`;
  return {
    id: `${mr.host}/${repository}/merge_requests/${number}`,
    source: 'mr',
    title: data.title || '',
    author: usernameOf(data.author),
    base: data.target_branch || '',
    head: data.source_branch || '',
    url: data.web_url || fallbackUrl,
    repository,
    number,
  };
};

const noteLine = (position) => {
  if (!position) return NO_LINE;
  const kind = position.position_type || 'text';
  if (kind === 'file' || kind === 'image') return NO_LINE;
  const newLine = Number(position.new_line);
  if (Number.isFinite(newLine) && newLine >= 1) {
    return { side: 'RIGHT', line: newLine };
  }
  const oldLine = Number(position.old_line);
  if (Number.isFinite(oldLine) && oldLine >= 1) {
    return { side: 'LEFT', line: oldLine };
  }
  return NO_LINE;
};

const noteToImported = (note, items, paths) => {
  if (!isHashObject(note) || note.system === true) return null;
  const body = commentBody(note.body);
  if (!body) return null;
  const resolved = note.resolved === true;
  const entry = { reviewer: usernameOf(note.author), body, resolved };
  if (note.type !== 'DiffNote') {
    return importedTodo(MR_TODO_FILE, entry, IMPORT_HOST);
  }
  const position = isHashObject(note.position) ? note.position : null;
  const path = position ? position.new_path || position.old_path || '' : '';
  if (path && !isPathInScope(path, paths)) return null;
  const { side, line } = noteLine(position);
  const loc = { path, line, side };
  return noteFromLocation(items, loc, entry, IMPORT_HOST, MR_TODO_FILE);
};

const discussionToNotes = (discussions, items, paths = []) => {
  const notes = [];
  for (const discussion of discussions ?? []) {
    if (!Array.isArray(discussion?.notes)) continue;
    for (const note of discussion.notes) {
      notes.push(noteToImported(note, items, paths));
    }
  }
  return splitNotes(notes);
};

const loadDiscussion = (mr, options) =>
  client.list(listUrl(`${mrApiUrl(mr)}/discussions`), options);

const issueApiUrl = (issue) => {
  const project = encodeURIComponent(issue.project);
  return `${issue.origin}/api/v4/projects/${project}/issues/${issue.number}`;
};

const toIssueChange = (issue, data) => {
  const number = data.iid || issue.number;
  const repository = issue.project;
  const fallbackUrl = `${issue.origin}/${repository}/-/issues/${number}`;
  return {
    id: `${issue.host}/${repository}/issues/${number}`,
    source: 'issue',
    title: data.title || '',
    author: usernameOf(data.author),
    base: '',
    head: '',
    url: data.web_url || fallbackUrl,
    repository,
    number,
  };
};

const issueClosed = (state) => `${state ?? ''}`.toLowerCase() === 'closed';

const gitlabIssuePage = (issue, data) => {
  if (data.web_url) return data.web_url;
  const number = data.iid || issue.number;
  if (!issue.origin || !issue.project || !number) return '';
  return `${issue.origin}/${issue.project}/-/issues/${number}`;
};

const gitlabIssueNotes = (issue, data, notes) => {
  const text = issueText(data.title, data.description);
  const main = text
    ? issueTodo(
        ISSUE_TODO_FILE,
        {
          reviewer: usernameOf(data.author),
          body: text,
          resolved: issueClosed(data.state),
          url: gitlabIssuePage(issue, data),
        },
        IMPORT_HOST,
      )
    : null;
  const rest = [];
  for (const note of notes) {
    if (!isHashObject(note) || note.system === true) continue;
    const body = commentBody(note.body);
    if (!body) continue;
    const entry = { reviewer: usernameOf(note.author), body };
    rest.push(issueTodo(ISSUE_TODO_FILE, entry, IMPORT_HOST));
  }
  return splitNotes([main, ...rest]);
};

const issueRequest = (options) => ({
  fetch: options.fetch ?? globalThis.fetch,
  token: options.token ?? '',
  retry: options.retry ?? {},
  signal: options.signal,
});

const isOpenGitlabIssue = (data) => {
  if (!isHashObject(data)) return false;
  return `${data.state ?? ''}`.toLowerCase() === 'opened';
};

const gitlabIssuesUrl = (issue) => {
  const project = encodeURIComponent(issue.project);
  return `${issue.origin}/api/v4/projects/${project}/issues?state=opened`;
};

const gitlabNotesUrl = (issue, number) => {
  const project = encodeURIComponent(issue.project);
  const base = `${issue.origin}/api/v4/projects/${project}/issues/${number}`;
  return listUrl(`${base}/notes`);
};

const tasksFromGitlabIssues = async (issue, rows, request) => {
  const tasks = [];
  for (const data of rows) {
    const notes = await issueClient.list(
      gitlabNotesUrl(issue, data.iid),
      request,
    );
    const imported = gitlabIssueNotes(issue, data, notes);
    tasks.push(...imported.tasks);
  }
  return tasks;
};

const listIssueChange = (issue) => {
  const repository = issue.project;
  const url = `${issue.origin}/${repository}/-/issues`;
  return {
    id: `${issue.host}/${repository}/issues`,
    source: 'issue',
    title: '',
    author: '',
    base: '',
    head: '',
    url,
    repository,
    number: 0,
  };
};

const loadGitlabIssueList = async (issue, options) => {
  const request = issueRequest(options);
  const list = listUrl(gitlabIssuesUrl(issue));
  const rows = await issueClient.list(list, request);
  const open = rows.filter(isOpenGitlabIssue);
  const tasks = await tasksFromGitlabIssues(issue, open, request);
  return {
    top: options.cwd,
    items: [],
    sourceLabel: issue.project,
    change: listIssueChange(issue),
    imported: { feedback: [], tasks },
  };
};

const loadGitlabIssue = async (issue, options = {}) => {
  if (issue.list) return loadGitlabIssueList(issue, options);
  const request = issueRequest(options);
  const url = issueApiUrl(issue);
  const page = await issueClient.request(url, request);
  const data = issueClient.parseJson(page.body, 'issue payload');
  const notes = await issueClient.list(listUrl(`${url}/notes`), request);
  const number = data.iid || issue.number;
  return {
    top: options.cwd,
    items: [],
    sourceLabel: `#${number}`,
    change: toIssueChange(issue, data),
    imported: gitlabIssueNotes(issue, data, notes),
  };
};

const loadMergeRequest = (mr, options = {}) => {
  const url = mrApiUrl(mr);
  return loadChange(mr, options, {
    client,
    url,
    diffUrl: `${url}/raw_diffs`,
    diffAccept: DIFF_ACCEPT,
    prefix: '!',
    toChange,
    loadDiscussion,
    discussionToNotes,
  });
};

module.exports = {
  parseGitlabMrUrl,
  parseGitlabIssueUrl,
  parseGitlabIssueListUrl,
  gitlabToken,
  mrApiUrl,
  discussionToNotes,
  loadGitlabIssue,
  loadMergeRequest,
};
