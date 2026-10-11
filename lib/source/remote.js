'use strict';

const { delay, jsonParse, isHashObject } = require('metautil');
const { oneLine, trimText } = require('../common/utilities.js');
const { itemPath, isPathInScope, ISSUE_FILE } = require('../common/files.js');
const { parseDiff, itemsFromFiles, isCtxType } = require('../diff/diff.js');
const { foldDepItems } = require('../deps/deps.js');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];

const abortError = (signal) => {
  if (signal && signal.reason !== undefined) return signal.reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error, signal) => {
  if (signal && signal.aborted) return true;
  return error?.name === 'AbortError' || error?.code === 'ABORT';
};

const throwIfAborted = (signal) => {
  if (signal && signal.aborted) throw abortError(signal);
};

const wait = async (ms, signal) => {
  try {
    await delay(ms, signal);
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
};

class RemoteClient {
  constructor(options) {
    this.name = options.name;
    this.subject = options.subject;
    this.prefix = options.name.toUpperCase();
    this.headers = options.headers;
    this.nextPage = options.nextPage;
    this.errorFields = options.errorFields ?? ['message'];
    this.limitStatus = options.limitStatus ?? 0;
  }

  error(code, message, extra = {}) {
    const fields = { code: `${this.prefix}_${code}`, ...extra };
    return Object.assign(new Error(message), fields);
  }

  parseJson(text, label, validate = isHashObject) {
    const data = jsonParse(text ?? '');
    if (validate(data)) return data;
    throw this.error('PARSE', `${this.name} API: invalid ${label}`);
  }

  httpError(status, body, token) {
    const { name, prefix } = this;
    const text = trimText(body);
    const parsed = jsonParse(text);
    const fields = this.errorFields;
    const field = fields.find((key) => typeof parsed?.[key] === 'string');
    const message =
      isHashObject(parsed) && field ? parsed[field] : oneLine(text);
    if (status === 404) {
      const hint = token
        ? ''
        : ` (set ${prefix}_TOKEN for private repositories)`;
      const notFound = `${name} ${this.subject} not found${hint}`;
      return this.error('NOT_FOUND', notFound, { status });
    }
    if (status === 401) {
      return this.error('AUTH', `${name} authentication failed`, { status });
    }
    const rateLimit = status === 403 && /rate limit/i.test(message);
    if (rateLimit || status === this.limitStatus) {
      const limited = `${name} API rate limit exceeded`;
      return this.error('RATE_LIMIT', limited, { status });
    }
    const detail = message ? `: ${oneLine(message)}` : ` HTTP ${status}`;
    return this.error('HTTP', `${name} API${detail}`, { status });
  }

  isRetryable(error) {
    if (error.code === `${this.prefix}_NETWORK`) return true;
    return TRANSIENT_STATUS.includes(error.status);
  }

  async fetchPage(url, options) {
    const { signal, token = '' } = options;
    const headers = this.headers(token, options.accept);
    if (options.contentType) headers['Content-Type'] = options.contentType;
    const init = { method: options.method || 'GET', headers };
    if (options.body !== undefined) init.body = options.body;
    if (signal) init.signal = signal;
    let response;
    try {
      response = await options.fetch(url, init);
    } catch (cause) {
      if (isAbortError(cause, signal)) throw cause;
      const detail = oneLine(cause && cause.message);
      const suffix = detail ? `: ${detail}` : '';
      const message = `${this.name} request failed${suffix}`;
      throw this.error('NETWORK', message, { cause });
    }
    const text = await response.text();
    if (!response.ok) throw this.httpError(response.status, text, token);
    return { body: text, headers: response.headers };
  }

  async request(url, options) {
    const { signal, retry = {} } = options;
    throwIfAborted(signal);
    if (typeof options.fetch !== 'function') {
      throw this.error('FETCH', 'fetch is not available');
    }
    const attempts = retry.attempts ?? RETRY_ATTEMPTS;
    const delayMs = retry.delayMs ?? RETRY_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.fetchPage(url, options);
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        if (attempt >= attempts || !this.isRetryable(error)) throw error;
        await wait(delayMs * attempt, signal);
      }
    }
  }

  async list(url, options) {
    const items = [];
    let next = url;
    while (next) {
      const page = await this.request(next, { ...options, method: 'GET' });
      const entries = this.parseJson(page.body, 'list payload', Array.isArray);
      items.push(...entries);
      next = this.nextPage(page.headers, next);
    }
    return items;
  }
}

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return `${headers[key]}`;
  }
  return '';
};

const parseLinkNext = (headers) => {
  const link = headerValue(headers, 'link');
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1];
  }
  return '';
};

const parseNextPage = (headers, currentUrl) => {
  const fromLink = parseLinkNext(headers);
  if (fromLink) return fromLink;
  const page = headerValue(headers, 'x-next-page');
  if (!page) return '';
  const url = new URL(currentUrl);
  url.searchParams.set('page', page);
  return url.toString();
};

const listUrl = (base) => {
  const url = new URL(base);
  url.searchParams.set('per_page', '100');
  return url.toString();
};

const commentBody = (value) => trimText(value);

const issueText = (title, body) => {
  const head = trimText(title);
  const rest = commentBody(body);
  if (head && rest) return `${head}\n\n${rest}`;
  return head || rest;
};

const sideLineNumber = (type, oldNo, newNo, side) => {
  if (side === 'LEFT') return type === 'add' ? 0 : oldNo;
  return type === 'del' ? 0 : newNo;
};

const locateLineInItem = (item, rel, line, side) => {
  const hunk = item.hunk;
  if (itemPath(item) !== rel || !hunk || !line) return null;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const entry of hunk.lines) {
    const at = sideLineNumber(entry.type, oldNo, newNo, side);
    if (at === line) return { inBlock: entry.blockId === item.blockId };
    const isCtx = isCtxType(entry.type);
    if (isCtx || entry.type === 'del') oldNo += 1;
    if (isCtx || entry.type === 'add') newNo += 1;
  }
  return null;
};

const findItemForLine = (items, rel, line, side) => {
  let fallback = null;
  for (const item of items) {
    const hit = locateLineInItem(item, rel, line, side);
    if (!hit) continue;
    if (hit.inBlock) return item;
    if (!fallback) fallback = item;
  }
  return fallback;
};

const importedText = (entry, host) => {
  const reviewer = entry.reviewer || 'unknown';
  return `@${reviewer} review at ${host}: ${commentBody(entry.body)}`;
};

const importedTodo = (file, entry, host) => ({
  kind: 'todo',
  file,
  text: importedText(entry, host),
  done: entry.resolved === true,
});

const issueTodoText = (entry, host) => {
  const reviewer = entry.reviewer || 'unknown';
  const body = `@${reviewer} at ${host}: ${commentBody(entry.body)}`;
  const url = trimText(entry.url);
  if (!url) return body;
  return `${body}\nIssue: ${url}`;
};

const issueTodo = (entry, host) => ({
  kind: 'todo',
  file: ISSUE_FILE,
  text: issueTodoText(entry, host),
  done: entry.resolved === true,
});

const importedFeedback = (item, path, entry, host) => {
  const hunk = item.hunk;
  return {
    kind: 'feedback',
    file: itemPath(item) || path,
    oldStart: hunk ? hunk.oldStart : 0,
    newStart: hunk ? hunk.newStart : 0,
    blockId: item.blockId ?? 0,
    origin: item.origin ?? 'pr',
    header: hunk ? hunk.header : '',
    text: importedText(entry, host),
    done: entry.resolved === true,
  };
};

const noteFromLocation = (items, loc, entry, host, fallbackFile) => {
  const path = loc.path || '';
  if (loc.line && path) {
    const item = findItemForLine(items, path, loc.line, loc.side);
    if (item) return importedFeedback(item, path, entry, host);
  }
  return importedTodo(path || fallbackFile, entry, host);
};

const splitNotes = (notes) => {
  const feedback = [];
  const tasks = [];
  for (const note of notes) {
    if (!note) continue;
    if (note.kind === 'feedback') feedback.push(note);
    else tasks.push(note);
  }
  return { feedback, tasks };
};

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  return files.filter((file) =>
    isPathInScope(file.newPath || file.oldPath || '', paths),
  );
};

const changeFiles = (items) => {
  const rels = new Set();
  for (const item of items) {
    const paths = item.dep ? item.dep.files : [itemPath(item)];
    for (const rel of paths ?? []) {
      if (rel) rels.add(rel);
    }
  }
  return [...rels];
};

const requestOptions = (options) => ({
  fetch: options.fetch ?? globalThis.fetch,
  token: options.token ?? '',
  retry: options.retry ?? {},
  signal: options.signal,
});

const stateIs = (state, name) => `${state ?? ''}`.toLowerCase() === name;

const issueChange = (site, issue) => {
  const number = issue.number || 0;
  const tail = number ? `/${number}` : '';
  return {
    id: `${site.id}${tail}`,
    source: 'issue',
    title: issue.title || '',
    author: issue.author || '',
    base: '',
    head: '',
    url: issue.url || `${site.page}${tail}`,
    repository: site.repository,
    number,
  };
};

const issueTasks = (source, issue, url, comments) => {
  const { host, readComment } = source;
  const tasks = [];
  const body = issueText(issue.title, issue.body);
  if (body) {
    const resolved = stateIs(issue.state, 'closed');
    const entry = { reviewer: issue.author, body, resolved, url };
    tasks.push(issueTodo(entry, host));
  }
  for (const comment of comments) {
    const entry = readComment(comment);
    if (!entry || !commentBody(entry.body)) continue;
    tasks.push(issueTodo(entry, host));
  }
  return tasks;
};

const loadIssue = async (ref, options, source) => {
  const { client, site, issuesUrl, readIssue } = source;
  const request = requestOptions(options);
  const readComments = (number) => {
    const url = `${issuesUrl}/${number}/${source.comments}`;
    return client.list(listUrl(url), request);
  };
  const tasks = [];
  let change = issueChange(site, {});
  if (ref.list) {
    const open = listUrl(`${issuesUrl}?state=${source.openState}`);
    for (const data of await client.list(open, request)) {
      if (!source.isOpen(data)) continue;
      const issue = readIssue(data);
      const quiet = issue.comments === 0;
      const comments = quiet ? [] : await readComments(issue.number);
      const { url } = issueChange(site, issue);
      tasks.push(...issueTasks(source, issue, url, comments));
    }
  } else {
    const [page, comments] = await Promise.all([
      client.request(`${issuesUrl}/${ref.number}`, request),
      readComments(ref.number),
    ]);
    const data = client.parseJson(page.body, 'issue payload');
    const issue = readIssue(data);
    issue.number ||= ref.number;
    change = issueChange(site, issue);
    tasks.push(...issueTasks(source, issue, change.url, comments));
  }
  return {
    top: options.cwd,
    items: [],
    sourceLabel: ref.list ? site.repository : `#${change.number}`,
    change,
    imported: { feedback: [], tasks },
  };
};

const loadChange = async (ref, options, source) => {
  const { client, url, diffUrl = url, diffAccept } = source;
  const { cwd, paths = [], signal } = options;
  const request = requestOptions(options);
  const discussion = Promise.resolve().then(() =>
    source.loadDiscussion(ref, request),
  );
  discussion.catch(() => {});
  const [jsonPage, diffPage] = await Promise.all([
    client.request(url, request),
    client.request(diffUrl, { ...request, accept: diffAccept }),
  ]);
  const data = client.parseJson(jsonPage.body, `${client.subject} payload`);
  const files = filterChangeFiles(parseDiff(diffPage.body), paths);
  const items = foldDepItems(itemsFromFiles(files, 'pr'));
  const change = {
    ...source.toChange(ref, data),
    files: changeFiles(items),
    status: 'reviewing',
  };
  const sourceLabel = `${source.prefix}${change.number}`;
  let imported = { feedback: [], tasks: [] };
  try {
    imported = source.discussionToNotes(await discussion, items, paths);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
  }
  return { top: cwd, items, sourceLabel, change, imported };
};

module.exports = {
  RemoteClient,
  isAbortError,
  parseLinkNext,
  parseNextPage,
  listUrl,
  commentBody,
  importedTodo,
  noteFromLocation,
  splitNotes,
  stateIs,
  filterChangeFiles,
  loadIssue,
  loadChange,
};
