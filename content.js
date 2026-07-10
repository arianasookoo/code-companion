// Code Companion - content script: extracts code from the current page.
// Priority: user selection > code editors (Monaco/CodeMirror/Ace) > <pre>/<code> blocks > textareas.

(() => {
  if (window.__codeCompanionInjected) return;
  window.__codeCompanionInjected = true;

  const MAX_CHARS = 60000; // keep prompts within reasonable token limits

  function getSelectionCode() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    return text.length > 3 ? text : null;
  }

  function getEditorCode() {
    const blocks = [];

    // CodeMirror 6
    document.querySelectorAll('.cm-content').forEach((el) => {
      const text = el.innerText;
      if (text?.trim()) blocks.push({ text, source: 'CodeMirror editor' });
    });

    // CodeMirror 5
    document.querySelectorAll('.CodeMirror').forEach((el) => {
      if (el.CodeMirror?.getValue) {
        const text = el.CodeMirror.getValue();
        if (text?.trim()) blocks.push({ text, source: 'CodeMirror editor' });
      } else {
        const code = el.querySelector('.CodeMirror-code');
        if (code?.innerText?.trim()) blocks.push({ text: code.innerText, source: 'CodeMirror editor' });
      }
    });

    // Monaco (VS Code web, LeetCode, etc.) - reads visible lines
    document.querySelectorAll('.monaco-editor .view-lines').forEach((el) => {
      const lines = [...el.querySelectorAll('.view-line')]
        .map((l) => ({ top: parseInt(l.style.top || '0', 10), text: l.innerText }))
        .sort((a, b) => a.top - b.top)
        .map((l) => l.text);
      const text = lines.join('\n');
      if (text.trim()) blocks.push({ text, source: 'Monaco editor (visible lines only)' });
    });

    // Ace
    document.querySelectorAll('.ace_editor').forEach((el) => {
      const text = window.ace?.edit ? tryAce(el) : el.querySelector('.ace_content')?.innerText;
      if (text?.trim()) blocks.push({ text, source: 'Ace editor' });
    });

    function tryAce(el) {
      try { return window.ace.edit(el).getValue(); } catch { return null; }
    }

    return blocks;
  }

  function getStaticCode() {
    const blocks = [];
    const seen = new Set();

    document.querySelectorAll('pre').forEach((el) => {
      const text = el.innerText;
      if (text?.trim().length > 10) {
        blocks.push({ text, source: langHint(el) || 'code block' });
        el.querySelectorAll('code').forEach((c) => seen.add(c));
      }
    });

    document.querySelectorAll('code').forEach((el) => {
      if (seen.has(el)) return;
      const text = el.innerText;
      // standalone <code> only if it looks like a block, not inline
      if (text?.trim().length > 40 && text.includes('\n')) {
        blocks.push({ text, source: langHint(el) || 'code block' });
      }
    });

    document.querySelectorAll('textarea').forEach((el) => {
      const text = el.value;
      if (text?.trim().length > 40 && looksLikeCode(text)) {
        blocks.push({ text, source: 'textarea' });
      }
    });

    return blocks;
  }

  function langHint(el) {
    const cls = `${el.className} ${el.parentElement?.className || ''}`;
    const m = cls.match(/(?:language|lang)-([\w+#-]+)/i);
    return m ? `${m[1]} code block` : null;
  }

  function looksLikeCode(text) {
    return /[{};=<>]|def |function |class |import |const |let |var |return /.test(text);
  }

  function dedupe(blocks) {
    const out = [];
    const seen = new Set();
    for (const b of blocks) {
      const key = b.text.trim().slice(0, 200);
      if (!seen.has(key)) { seen.add(key); out.push(b); }
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'EXTRACT_CODE') return;

    const selection = getSelectionCode();
    if (selection) {
      sendResponse({ code: selection.slice(0, MAX_CHARS), source: 'selection', blockCount: 1 });
      return;
    }

    let blocks = dedupe([...getEditorCode(), ...getStaticCode()]);
    // largest blocks first, keep top 5
    blocks.sort((a, b) => b.text.length - a.text.length);
    blocks = blocks.slice(0, 5);

    if (!blocks.length) {
      sendResponse({ code: '', source: 'none', blockCount: 0 });
      return;
    }

    const combined = blocks
      .map((b, i) => (blocks.length > 1 ? `// --- Block ${i + 1} (${b.source}) ---\n${b.text}` : b.text))
      .join('\n\n')
      .slice(0, MAX_CHARS);

    sendResponse({ code: combined, source: blocks[0].source, blockCount: blocks.length });
  });
})();
