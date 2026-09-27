'use strict';

const files = require('./files.js');
const { isPathInScope } = files;
const remote = require('./remote.js');
const { isRecord } = remote;
const { createClient, listUrl, parseNextPage } = remote;
const { filterChangeFiles, changeFiles, loadChange } = remote;
const { importedText, importedTodo, noteFromLocation } = remote;

const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/json';
const DIFF_ACCEPT = 'text/plain';
const MR_TODO_FILE = 'merge request';
const IMPORT_HOST = 'gitlab';

const GITLAB_MR_RE = new RegExp(
  String.raw`^(?:(https?)://)?(?:www\.)?([^/?#]+)/` +
    String.raw`(.+?)(?:/-)?/merge_requests/(\d+)` +
    String.raw`(?:\.diff|\.patch)?` +
    String.raw`(?:/(?:diffs|commits|pipelines|changes)?)?` +
    String.raw`/?(?:[?#].*)?$`,
  'i',
);

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
  const todos = [];
  const threads = discussions ?? [];
  for (const discussion of threads) {
    if (!isRecord(discussion)) continue;
    const notes = Array.isArray(discussion.notes) ? discussion.notes : [];
    for (const note of notes) {
      const mapped = noteToImported(note, items, paths);
      if (!mapped) continue;
      if (mapped.kind === 'feedback') feedback.push(mapped);
      else todos.push(mapped);
    }
  }
  return { feedback, todos };
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

module.exports = {
  parseGitlabMrUrl,
  gitlabToken,
  filterChangeFiles,
  mrApiUrl,
  formatImportedText,
  discussionToNotes,
  loadMergeRequest,
};
