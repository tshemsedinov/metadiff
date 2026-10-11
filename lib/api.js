'use strict';
const ansi = require('./term/ansi.js');
const diff = require('./diff/diff.js');
const git = require('./git/git.js');
const keys = require('./input/keys.js');
const render = require('./render/render.js');
const highlight = require('./highlight/highlight.js');
const github = require('./source/github.js');
const gitlab = require('./source/gitlab.js');
const source = require('./source/source.js');
const { Session } = require('./session/session.js');
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
  detectLang: highlight.detectLang,
  run: cli.run,
  Session,
};
