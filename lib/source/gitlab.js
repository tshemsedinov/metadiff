'use strict';

const { isHashObject } = require('metautil');
const { isPathInScope } = require('../common/files.js');
const remote = require('./remote.js');
const { RemoteClient, listUrl, parseNextPage, commentBody } = remote;
const { importedTodo, noteFromLocation, splitNotes, loadChange } = remote;
const { stateIs, loadIssue } = remote;

const USER_AGENT = 'reslop';
const JSON_ACCEPT = 'application/json';
const DIFF_ACCEPT = 'text/plain';
const MR_TODO_FILE = 'merge request';
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

const parseGitlabUrl = (text, pattern) => {
  if (typeof text !== 'string' || !text) return null;
  const match = pattern.exec(text.trim());
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

const parseGitlabMrUrl = (text) => parseGitlabUrl(text, GITLAB_MR_RE);

const parseGitlabIssueUrl = (text) => {
  const issue = parseGitlabUrl(text, GITLAB_ISSUE_RE);
  return issue?.host.toLowerCase() === 'github.com' ? null : issue;
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

const projectApiUrl = (ref) =>
  `${ref.origin}/api/v4/projects/${encodeURIComponent(ref.project)}`;

const mrApiUrl = (mr) => `${projectApiUrl(mr)}/merge_requests/${mr.number}`;

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

const issueSite = (issue) => ({
  repository: issue.project,
  id: `${issue.host}/${issue.project}/issues`,
  page: `${issue.origin}/${issue.project}/-/issues`,
});

const readIssue = (data) => ({
  number: data.iid,
  title: data.title,
  body: data.description,
  author: usernameOf(data.author),
  state: data.state,
  url: data.web_url,
  comments: data.user_notes_count,
});

const readIssueNote = (note) => {
  if (!isHashObject(note) || note.system === true) return null;
  return { reviewer: usernameOf(note.author), body: note.body };
};

const isOpenIssue = (data) =>
  isHashObject(data) && stateIs(data.state, 'opened');

const loadGitlabIssue = async (issue, options = {}) =>
  loadIssue(issue, options, {
    client,
    host: IMPORT_HOST,
    site: issueSite(issue),
    issuesUrl: `${projectApiUrl(issue)}/issues`,
    openState: 'opened',
    comments: 'notes',
    isOpen: isOpenIssue,
    readIssue,
    readComment: readIssueNote,
  });

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
