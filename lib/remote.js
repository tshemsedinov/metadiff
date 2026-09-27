'use strict';

const metautil = require('metautil');
const { delay, jsonParse, isHashObject } = metautil;
const utilities = require('./utilities.js');
const { oneLine } = utilities;
const files = require('./files.js');
const { itemPath, isPathInScope } = files;
const diff = require('./diff/diff.js');
const { parseDiff, itemsFromFiles, isCtxType } = diff;
const deps = require('./deps.js');
const { foldDepItems } = deps;

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const TRANSIENT_STATUS = [429, 502, 503, 504];

const isRecord = isHashObject;

const abortError = (signal) => {
  if (signal && signal.reason !== undefined) return signal.reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error, signal) => {
  if (signal && signal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'AbortError') return true;
  if (error.code === 'ABORT') return true;
  return false;
};

const throwIfAborted = (signal) => {
  if (signal && signal.aborted) throw abortError(signal);
};

const wait = async (ms, abortSignal) => {
  try {
    await delay(ms, abortSignal);
  } catch (error) {
    throwIfAborted(abortSignal);
    throw error;
  }
};

const createTransport = (deps = {}) => {
  const fetchImpl = deps.fetch;
  const signal = deps.signal;

  const retry = async (run, options = {}) => {
    const attempts = options.attempts ?? RETRY_ATTEMPTS;
    const delayMs = options.delayMs ?? RETRY_DELAY_MS;
    const isRetryable = options.isRetryable;
    for (let i = 0; ; i++) {
      try {
        return await run();
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        const isLast = i === attempts - 1;
        if (isLast || !isRetryable(error)) throw error;
        throwIfAborted(signal);
        await wait(delayMs * (i + 1), signal);
      }
    }
  };

  const request = async (url, options = {}) => {
    throwIfAborted(signal);
    if (typeof fetchImpl !== 'function') {
      throw options.missingFetch();
    }
    const headers = options.headers;
    const method = options.method || 'GET';
    const body = options.body;
    const wrapNetwork = options.wrapNetwork;
    const toHttpError = options.toHttpError;
    const retryOpts = options.retry ?? {};
    return retry(
      async () => {
        let response;
        try {
          const init = { method, headers };
          if (body !== undefined) init.body = body;
          if (signal) init.signal = signal;
          response = await fetchImpl(url, init);
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          throw wrapNetwork(error);
        }
        const text = await response.text();
        if (!response.ok) throw toHttpError(response.status, text);
        return { body: text, headers: response.headers };
      },
      { ...retryOpts, isRetryable: options.isRetryable },
    );
  };

  const listPages = async (url, options = {}) => {
    const items = [];
    let next = url;
    const parsePage = options.parsePage;
    const nextPage = options.nextPage;
    while (next) {
      const page = await request(next, options);
      const entries = parsePage(page.body);
      for (const entry of entries) items.push(entry);
      next = nextPage(page.headers, next);
    }
    return items;
  };

  return { retry, request, listPages };
};

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (key.toLowerCase() === wanted) return `${value}`;
  }
  return '';
};

const parseLinkNext = (headers) => {
  const link = headerValue(headers, 'link');
  if (!link) return '';
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

const createClient = ({ name, subject, headers, nextPage }) => {
  const prefix = name.toUpperCase();
  const error = (code, message, extra = {}) =>
    Object.assign(new Error(message), { code: `${prefix}_${code}`, ...extra });

  const parseJson = (text, label, validate = isHashObject) => {
    const data = jsonParse(text ?? '');
    if (!validate(data)) throw error('PARSE', `${name} API: invalid ${label}`);
    return data;
  };

  const httpError = (status, body, token) => {
    const text = `${body ?? ''}`.trim();
    const parsed = jsonParse(text);
    const fields = name === 'GitLab' ? ['message', 'error'] : ['message'];
    const field = fields.find((key) => typeof parsed?.[key] === 'string');
    const message =
      isHashObject(parsed) && field ? parsed[field] : oneLine(text);
    if (status === 404) {
      const hint = token
        ? ''
        : ` (set ${prefix}_TOKEN for private repositories)`;
      return error('NOT_FOUND', `${name} ${subject} not found${hint}`, {
        status,
      });
    }
    if (status === 401) {
      return error('AUTH', `${name} authentication failed`, { status });
    }
    const rateLimit = status === 403 && /rate limit/i.test(message);
    if (rateLimit || (name === 'GitLab' && status === 429)) {
      return error('RATE_LIMIT', `${name} API rate limit exceeded`, { status });
    }
    const detail = message ? `: ${oneLine(message)}` : ` HTTP ${status}`;
    return error('HTTP', `${name} API${detail}`, { status });
  };

  const policy = (options) => ({
    retry: options.retry ?? {},
    isRetryable: (err) =>
      err.code === `${prefix}_NETWORK` || TRANSIENT_STATUS.includes(err.status),
    missingFetch: () => error('FETCH', 'fetch is not available'),
    toHttpError: (status, body) => httpError(status, body, options.token),
    wrapNetwork: (cause) => {
      const detail = oneLine(cause && cause.message);
      const suffix = detail ? `: ${detail}` : '';
      return error('NETWORK', `${name} request failed${suffix}`, { cause });
    },
    method: options.method || 'GET',
    headers: headers(options.token || '', options.accept),
  });

  const request = (url, options) => {
    const init = policy(options);
    if (options.contentType) init.headers['Content-Type'] = options.contentType;
    return createTransport(options).request(url, {
      ...init,
      body: options.body,
    });
  };

  const list = (url, options) =>
    createTransport(options).listPages(url, {
      ...policy(options),
      method: 'GET',
      parsePage: (text) => parseJson(text, 'list payload', Array.isArray),
      nextPage,
    });

  return { parseJson, request, list, subject };
};

const sideLineNumber = (type, oldNo, newNo, side) => {
  if (side === 'LEFT') {
    if (type === 'add') return 0;
    return oldNo;
  }
  if (type === 'del') return 0;
  return newNo;
};

const locateLineInItem = (item, rel, line, side) => {
  const path = itemPath(item);
  if (path !== rel) return null;
  const hunk = item.hunk;
  if (!hunk || !line) return null;
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const entry of hunk.lines) {
    const at = sideLineNumber(entry.type, oldNo, newNo, side);
    if (at === line) {
      const inBlock = entry.blockId === item.blockId;
      return { inBlock };
    }
    if (isCtxType(entry.type) || entry.type === 'del') {
      oldNo += 1;
    }
    if (isCtxType(entry.type) || entry.type === 'add') {
      newNo += 1;
    }
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
  const body = `${entry.body ?? ''}`.trim();
  return `@${reviewer} review at ${host}: ${body}`;
};

const importedTodo = (file, entry, host) => ({
  kind: 'todo',
  file,
  text: importedText(entry, host),
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
  const line = loc.line;
  const side = loc.side;
  if (line && path) {
    const item = findItemForLine(items, path, line, side);
    if (item) return importedFeedback(item, path, entry, host);
  }
  if (path) return importedTodo(path, entry, host);
  return importedTodo(fallbackFile, entry, host);
};

const changePath = (file) => file.newPath || file.oldPath || '';

const filterChangeFiles = (files, paths) => {
  if (!paths.length) return files;
  return files.filter((file) => isPathInScope(changePath(file), paths));
};

const changeFiles = (items) => {
  const files = new Set();
  for (const item of items) {
    const paths = item.dep ? item.dep.files : [itemPath(item)];
    for (const rel of paths ?? []) {
      if (rel) files.add(rel);
    }
  }
  return [...files];
};

const loadChange = async (ref, options, source) => {
  const { client, url, diffUrl = url, diffAccept } = source;
  const {
    cwd,
    paths = [],
    fetch = globalThis.fetch,
    token = '',
    retry = {},
    signal,
  } = options;
  const request = { fetch, token, retry, signal };
  const jsonPage = await client.request(url, request);
  const data = client.parseJson(jsonPage.body, `${client.subject} payload`);
  const diffPage = await client.request(diffUrl, {
    ...request,
    accept: diffAccept,
  });
  const files = filterChangeFiles(parseDiff(diffPage.body), paths);
  const items = foldDepItems(itemsFromFiles(files, 'pr'));
  const change = source.toChange(ref, data, items);
  const sourceLabel = `${source.prefix}${change.number}`;
  let imported = { feedback: [], todos: [] };
  try {
    const discussion = await source.loadDiscussion(ref, request);
    imported = source.discussionToNotes(discussion, items, paths);
  } catch (error) {
    if (isAbortError(error, request.signal)) throw error;
    // Discussion import is optional.
  }
  return { top: cwd, items, sourceLabel, change, imported };
};

module.exports = {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  TRANSIENT_STATUS,
  isRecord,
  isAbortError,
  createTransport,
  headerValue,
  parseLinkNext,
  parseNextPage,
  createClient,
  listUrl,
  findItemForLine,
  importedText,
  importedTodo,
  noteFromLocation,
  changePath,
  filterChangeFiles,
  changeFiles,
  loadChange,
};
