'use strict';

const review = require('../review/review.js');
const { rankedTemplates, prefixTemplates, TEMPLATE_SHOW } = review;

class TemplatePick {
  constructor(composer) {
    this.composer = composer;
  }

  shownTemplates() {
    const notes = this.composer.ui.review.store;
    if (!notes) return [];
    const { composeKind, editor } = this.composer;
    if (composeKind && composeKind !== 'feedback') return [];
    const ranked = rankedTemplates(notes.templates);
    const typed = composeKind && editor ? editor.text : '';
    if (ranked.some((entry) => entry.text === typed)) return [];
    return prefixTemplates(ranked, typed).slice(0, TEMPLATE_SHOW);
  }

  clampedTemplateIndex(shown) {
    if (!shown.length) return -1;
    return Math.min(this.composer.templateIndex, shown.length - 1);
  }

  clearTemplatePick() {
    this.composer.templateIndex = -1;
    this.composer.templateFocus = false;
  }

  focusTemplate(index, apply) {
    const shown = this.shownTemplates();
    if (!shown.length) return;
    let i = index;
    if (i < 0) i = shown.length - 1;
    if (i >= shown.length) i = 0;
    this.composer.templateIndex = i;
    this.composer.templateFocus = true;
    if (apply) this.composer.editor.replace(shown[i].text);
  }

  selectTemplate(index) {
    if (!this.shownTemplates().length) return null;
    this.focusTemplate(index, true);
    return this.composer.saveCompose();
  }

  applyTemplate() {
    const { composeKind, templateFocus, templateIndex } = this.composer;
    if (composeKind !== 'feedback') return null;
    return this.selectTemplate(templateFocus ? templateIndex : 0);
  }
}

module.exports = { TemplatePick };
