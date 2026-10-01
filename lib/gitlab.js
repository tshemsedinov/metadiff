'use strict';

const metautil = require('metautil');
const { isHashObject } = metautil;
const files = require('./files.js');
const { isPathInScope } = files;
const remote = require('./remote.js');
const { RemoteClient, listUrl, parseNextPage, commentBody } = remote;
const { importedTodo, noteFromLocation, splitNotes, loadChange } = remote;

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
  mrApiUrl,
  discussionToNotes,
  loadMergeRequest,
};
