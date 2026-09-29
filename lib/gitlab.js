'use strict';

const files = require('./files.js');
const { isPathInScope } = files;
const remote = require('./remote.js');
const { isRecord } = remote;
const { createClient, listUrl, parseNextPage } = remote;
const { filterChangeFiles, changeFiles, loadChange } = remote;
const { importedText, importedTodo, noteFromLocation, importedIssueTodo } =
  remote;

const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/json';
const DIFF_ACCEPT = 'text/plain';
const MR_TODO_FILE = 'merge request';
const IMPORT_HOST = 'gitlab';

const GITLAB_ISSUE_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/issues/(\d+)` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const GITLAB_MR_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/merge_requests/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:diffs|commits|pipelines|changes)?)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

const parseGitlabIssueUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_ISSUE_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  const rawProject = match[3];
  const project = rawProject.replace(/\.git$/i, '');
  const number = parseInt(match[4], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!host || !project || !hasNumber) return null;
  const origin = `${scheme}://${host}`;
  return { host, project, number, origin };
};

const parseGitlabMrUrl = (text) => {
  if (typeof text !== 'string' || !text) return null;
  const match = GITLAB_MR_RE.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] || 'https').toLowerCase();
  const host = match[2];
  const rawProject = match[3];
  const project = rawProject.replace(/\.git$/i, '');
  const number = parseInt(match[4], 10);
  const hasNumber = Number.isFinite(number) && number >= 1;
  if (!host || !project || !hasNumber) return null;
  const origin = `${scheme}://${host}`;
  return { host, project, number, origin };
};

const gitlabToken = (env) => {
  const from = env ?? process.env;
  return from.GITLAB_TOKEN || from.GL_TOKEN || '';
};

const gitlabHeaders = (token, accept = JSON_ACCEPT) => {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
  };
  if (!token) return headers;
  return { ...headers, 'PRIVATE-TOKEN': token };
};

const client = createClient({
  name: 'GitLab',
  subject: 'merge request',
  headers: gitlabHeaders,
  nextPage: parseNextPage,
});

const issueClient = createClient({
  name: 'GitLab',
  subject: 'issue',
  headers: gitlabHeaders,
  nextPage: parseNextPage,
});
const { list: requestGitlabList } = client;

const mrApiUrl = (mr) => {
  const project = encodeURIComponent(mr.project);
  const base = `${mr.origin}/api/v4/projects/${project}`;
  return `${base}/merge_requests/${mr.number}`;
};

const readUsername = (user) => {
  if (!isRecord(user)) return '';
  return user.username || '';
};

const readProject = (data, mr) => {
  const refs = isRecord(data.references) ? data.references : null;
  const full = refs && refs.full;
  if (typeof full === 'string') {
    const cut = full.lastIndexOf('!');
    if (cut > 0) return full.slice(0, cut);
  }
  return mr.project;
};

const toChange = (mr, data, items) => {
  const number = data.iid || mr.number;
  const repository = readProject(data, mr);
  const title = data.title || '';
  const author = readUsername(data.author);
  const files = changeFiles(items);
  const base = data.target_branch || '';
  const head = data.source_branch || '';
  const fallbackUrl = `${mr.origin}/${repository}/-/merge_requests/${number}`;
  const url = data.web_url || fallbackUrl;
  const id = `${mr.host}/${repository}/merge_requests/${number}`;
  return {
    id,
    source: 'mr',
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
  const login = readUsername(record && record.author);
  return login || 'unknown';
};

const formatImportedText = (entry) => importedText(entry, IMPORT_HOST);

const noteLine = (position) => {
  if (!isRecord(position)) return { side: 'RIGHT', line: 0 };
  const kind = position.position_type || 'text';
  if (kind === 'file' || kind === 'image') {
    return { side: 'RIGHT', line: 0 };
  }
  const newLine = Number(position.new_line);
  if (Number.isFinite(newLine) && newLine >= 1) {
    return { side: 'RIGHT', line: newLine };
  }
  const oldLine = Number(position.old_line);
  if (Number.isFinite(oldLine) && oldLine >= 1) {
    return { side: 'LEFT', line: oldLine };
  }
  return { side: 'RIGHT', line: 0 };
};

const noteToImported = (note, items, paths) => {
  if (!isRecord(note) || note.system === true) return null;
  const body = readCommentBody(note.body);
  if (!body) return null;
  const resolved = note.resolved === true;
  const entry = {
    reviewer: reviewerOf(note),
    body,
    resolved,
  };
  if (note.type !== 'DiffNote') {
    return importedTodo(MR_TODO_FILE, entry, IMPORT_HOST);
  }
  const position = isRecord(note.position) ? note.position : null;
  const path = position ? position.new_path || position.old_path || '' : '';
  if (path && !isPathInScope(path, paths)) return null;
  const { side, line } = noteLine(position);
  return noteFromLocation(
    items,
    { path, line, side },
    entry,
    IMPORT_HOST,
    MR_TODO_FILE,
  );
};

const discussionToNotes = (discussions, items, paths = []) => {
  const feedback = [];
  const tasks = [];
  const threads = discussions ?? [];
  for (const discussion of threads) {
    if (!isRecord(discussion)) continue;
    const notes = Array.isArray(discussion.notes) ? discussion.notes : [];
    for (const note of notes) {
      const mapped = noteToImported(note, items, paths);
      if (!mapped) continue;
      if (mapped.kind === 'feedback') feedback.push(mapped);
      else tasks.push(mapped);
    }
  }
  return { feedback, tasks };
};

const loadDiscussion = async (mr, options) => {
  const url = listUrl(`${mrApiUrl(mr)}/discussions`);
  return requestGitlabList(url, options);
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

const ISSUE_FILE = 'issue';

const issueApiUrl = (issue) => {
  const project = encodeURIComponent(issue.project);
  const base = `${issue.origin}/api/v4/projects/${project}`;
  return `${base}/issues/${issue.number}`;
};

const readIssueProject = (data, issue) => {
  const refs = isRecord(data.references) ? data.references : null;
  const full = refs && refs.full;
  if (typeof full === 'string') {
    const cut = full.lastIndexOf('#');
    if (cut > 0) return full.slice(0, cut);
  }
  return issue.project;
};

const readLabels = (data) => {
  if (!Array.isArray(data.labels)) return [];
  const names = [];
  for (const label of data.labels) {
    if (typeof label === 'string' && label) names.push(label);
  }
  return names;
};

const normalizeGitlabIssue = (data, issue) => {
  const number = data.iid || issue.number;
  const repository = readIssueProject(data, issue);
  const title = data.title || '';
  const body = data.description || data.body || '';
  const author = readUsername(data.author);
  const fallback = `${issue.origin}/${repository}/-/issues/${number}`;
  const url = data.web_url || fallback;
  return {
    type: 'issue',
    host: IMPORT_HOST,
    number,
    title,
    body,
    author,
    url,
    labels: readLabels(data),
    state: data.state || 'open',
    repository,
  };
};

const issueCommentTodo = (note) => {
  if (!isRecord(note) || note.system === true) return null;
  const body = readCommentBody(note.body);
  if (!body) return null;
  return importedIssueTodo(
    ISSUE_FILE,
    {
      author: readUsername(note.author),
      title: '',
      body,
    },
    IMPORT_HOST,
  );
};

const issueToNotes = (issueRecord, notes) => {
  const tasks = [
    importedIssueTodo(
      ISSUE_FILE,
      {
        author: issueRecord.author,
        title: issueRecord.title,
        body: issueRecord.body,
        labels: issueRecord.labels,
        done: issueRecord.state === 'closed',
      },
      IMPORT_HOST,
    ),
  ];
  const list = Array.isArray(notes) ? notes : [];
  for (const note of list) {
    const task = issueCommentTodo(note);
    if (task) tasks.push(task);
  }
  return { feedback: [], tasks };
};

const issueChange = (issue, record) => ({
  id: `${issue.host}/${record.repository}/issues/${record.number}`,
  source: 'issue',
  title: record.title,
  author: record.author,
  files: [],
  status: record.state || 'open',
  base: '',
  head: '',
  url: record.url,
  repository: record.repository,
  number: record.number,
});

const loadIssue = async (issue, options = {}) => {
  const { fetch = globalThis.fetch, token = '', retry = {}, signal } = options;
  const request = { fetch, token, retry, signal };
  const url = issueApiUrl(issue);
  const page = await issueClient.request(url, request);
  const data = issueClient.parseJson(page.body, 'issue payload');
  const record = normalizeGitlabIssue(data, issue);
  const notes = await issueClient.list(listUrl(`${url}/notes`), request);
  return {
    sourceLabel: `#${record.number}`,
    change: issueChange(issue, record),
    imported: issueToNotes(record, notes),
    items: [],
  };
};

module.exports = {
  parseGitlabMrUrl,
  parseGitlabIssueUrl,
  gitlabToken,
  filterChangeFiles,
  mrApiUrl,
  issueApiUrl,
  formatImportedText,
  discussionToNotes,
  issueToNotes,
  loadMergeRequest,
  loadIssue,
};
