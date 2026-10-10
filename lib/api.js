'use strict';
const ansi = require('./ansi.js');
const diff = require('./diff/diff.js');
const git = require('./git.js');
const keys = require('./keys.js');
const render = require('./render/render.js');
const highlight = require('./highlight.js');
const detect = require('./detect.js');
const github = require('./github.js');
const gitlab = require('./gitlab.js');
const source = require('./source.js');
const { Session } = require('./session.js');
const cli = require('./cli.js');

module.exports = {
  THEME: ansi.THEME,
  CODE_FG: ansi.CODE_FG,
  THEME_NAMES: ansi.THEME_NAMES,
  setTheme: ansi.setTheme,
  ACTIONS: keys.ACTIONS,
  diffChars: diff.diffChars,
  parseDiff: diff.parseDiff,
  splitHunk: diff.splitHunk,
  displayLines: diff.displayLines,
  formatPatch: diff.formatPatch,
  itemsFromFiles: diff.itemsFromFiles,
  createGitRepo: git.createGitRepo,
  parseGithubPrUrl: github.parseGithubPrUrl,
  parseGithubIssueUrl: github.parseGithubIssueUrl,
  parseGithubIssueListUrl: github.parseGithubIssueListUrl,
  loadPullRequest: github.loadPullRequest,
  loadGithubIssue: github.loadGithubIssue,
  parseGitlabMrUrl: gitlab.parseGitlabMrUrl,
  parseGitlabIssueUrl: gitlab.parseGitlabIssueUrl,
  parseGitlabIssueListUrl: gitlab.parseGitlabIssueListUrl,
  loadMergeRequest: gitlab.loadMergeRequest,
  loadGitlabIssue: gitlab.loadGitlabIssue,
  selectChangeSource: source.selectChangeSource,
  decodeChunk: keys.decodeChunk,
  hitAction: keys.hitAction,
  renderFrame: render.renderFrame,
  tokenize: highlight.tokenize,
  overlayTokens: highlight.overlayTokens,
  detectLang: detect.detectLang,
  run: cli.run,
  Session,
};
