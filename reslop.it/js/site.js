'use strict';

const INSTALL = 'npm i -g reslop';

const copyText = async (text, button) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.left = '-9999px';
    document.body.appendChild(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
  if (!button) return;
  button.dataset.copied = 'true';
  const prev = button.textContent;
  button.textContent = 'copied';
  window.setTimeout(() => {
    button.dataset.copied = 'false';
    button.textContent = prev;
  }, 1400);
};

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    const text = button.getAttribute('data-copy') || INSTALL;
    copyText(text, button);
  });
});
