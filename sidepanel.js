// Code Companion - side panel logic

// Lightweight shim so the panel degrades gracefully when opened outside a
// real installed Chrome extension (e.g. a plain browser preview). Inside the
// actual extension, chrome.* is already fully defined and this is a no-op.
if (typeof chrome === 'undefined' || !chrome.storage) {
  const memory = { local: {}, session: {} };
  const fakeArea = (area) => ({
    get: async (keys) => {
      if (!keys) return { ...memory[area] };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      list.forEach((k) => { if (k in memory[area]) out[k] = memory[area][k]; });
      return out;
    },
    set: async (obj) => { Object.assign(memory[area], obj); },
    remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete memory[area][k]); },
    onChanged: { addListener: () => {} },
  });
  window.chrome = {
    storage: { local: fakeArea('local'), session: fakeArea('session') },
    runtime: {
      sendMessage: async () => ({ ok: false, error: 'Not running inside the Chrome extension (preview mode).' }),
    },
  };
}

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const codeBox = $('codeBox');
const captureInfo = $('captureInfo');

// Model is fixed in this file — not user-selectable.
const OPENAI_MODEL_FALLBACK = 'gpt-4o-mini';
const DEFAULT_DAILY_GOAL = 5;
let settings = { apiKey: '', model: OPENAI_MODEL_FALLBACK };
let messages = []; // OpenAI-format conversation history (excludes system prompt)
let busy = false;

const SYSTEM_PROMPT = `You are Code Companion, an expert debugging assistant embedded in a Chrome extension.
The user shares code captured from a web page. Your priorities:
1. DEBUG: identify bugs, logic errors, edge cases, and runtime risks. Point to exact lines. Provide corrected code.
2. EXPLAIN: describe what the code does clearly and concisely.
3. OPTIMIZE: suggest performance, readability, and idiomatic improvements.
Be concise. Use markdown with fenced code blocks. If code appears truncated or is not actually code, say so.`;

// ---------- init ----------
(async function init() {
  const stored = await chrome.storage.local.get(['leetcodeUsername', 'dailyGoal']);

  await loadConfigFromEnv();

  const dailyGoal = stored.dailyGoal || DEFAULT_DAILY_GOAL;
  $('settingsDailyGoal').value = dailyGoal;

  if (stored.leetcodeUsername) {
    $('settingsLcUsername').value = stored.leetcodeUsername;
    fetchLeetCodeStats(stored.leetcodeUsername, dailyGoal);
  } else {
    $('leetcodeStatus').textContent = 'Set your LeetCode username in Settings (⚙) to track progress.';
    $('settings').classList.remove('hidden'); // first-time setup prompt
  }

  // Code pending from the context menu?
  const { pendingCapture } = await chrome.storage.session.get('pendingCapture');
  if (pendingCapture?.code) {
    codeBox.value = pendingCapture.code;
    captureInfo.textContent = 'Captured from right-click selection.';
    chrome.storage.session.remove('pendingCapture');
  }
})();

// Reads OPENAI_API_KEY (and optional OPENAI_MODEL) out of the .env file
// bundled in the extension folder (KEY=VALUE lines, # comments ignored).
// No user-entered key, no model picker — both come from this file.
function readEnvVar(text, name) {
  const re = new RegExp('^\\s*' + name + '\\s*=', 'm');
  const line = text.split('\n').find((l) => re.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
}

async function loadConfigFromEnv() {
  const status = $('apiKeyStatus');
  try {
    const resp = await fetch('.env');
    if (!resp.ok) throw new Error('.env not found');
    const text = await resp.text();
    const key = readEnvVar(text, 'OPENAI_API_KEY');
    const model = readEnvVar(text, 'OPENAI_MODEL');
    if (model) settings.model = model;
    if (key) {
      settings.apiKey = key;
      if (status) status.textContent = '';
    } else if (status) {
      status.textContent = 'Add OPENAI_API_KEY to the .env file in the extension folder.';
    }
  } catch (e) {
    if (status) status.textContent = 'Could not read .env — add OPENAI_API_KEY=... to a .env file in the extension folder.';
  }
}

// Pick up context-menu captures while the panel is already open
chrome.storage.session.onChanged.addListener((changes) => {
  const cap = changes.pendingCapture?.newValue;
  if (cap?.code) {
    codeBox.value = cap.code;
    captureInfo.textContent = 'Captured from right-click selection.';
    chrome.storage.session.remove('pendingCapture');
  }
});

// ---------- capture ----------
$('captureBtn').onclick = async () => {
  captureInfo.innerHTML = '<span class="spinner"></span> Capturing…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_CODE' });
    if (!res?.ok) throw new Error(res?.error || 'Capture failed.');
    if (!res.code) {
      captureInfo.textContent = 'No code found on this page. Try highlighting the code first, or paste it manually.';
      return;
    }
    codeBox.value = res.code;
    captureInfo.textContent =
      res.source === 'selection'
        ? 'Captured your selection.'
        : `Captured ${res.blockCount} block(s) (${res.source}) from "${res.title || res.url}".`;
  } catch (e) {
    captureInfo.textContent = `Error: ${e.message}`;
  }
};

// ---------- actions ----------
const ACTION_PROMPTS = {
  debug: 'Debug this code. Find bugs, logic errors, and edge cases. Show fixes with corrected code:',
  explain: 'Explain what this code does, step by step but concisely:',
  optimize: 'Review this code for performance and readability. Suggest concrete optimizations with improved code:',
};

$('debugBtn').onclick = () => runAction('debug');
$('explainBtn').onclick = () => runAction('explain');
$('optimizeBtn').onclick = () => runAction('optimize');

function runAction(kind) {
  const code = codeBox.value.trim();
  if (!code) { captureInfo.textContent = 'Capture or paste some code first.'; return; }
  const label = kind[0].toUpperCase() + kind.slice(1) + ' the captured code';
  sendToAI(ACTION_PROMPTS[kind] + '\n\n```\n' + code + '\n```', label);
}

// ---------- LeetCode progress ----------
const lcStatus = $('leetcodeStatus');
const lcProgress = $('leetcodeProgress');
const lcRing = $('lcRingProgress');
const LC_RING_CIRCUMFERENCE = 2 * Math.PI * 34; // matches the r=34 circle in sidepanel.html

async function fetchLeetCodeStats(username, dailyGoal) {
  const goal = dailyGoal || DEFAULT_DAILY_GOAL;
  lcStatus.innerHTML = '<span class="spinner"></span> Loading progress…';
  lcProgress.classList.add('hidden');
  try {
    const resp = await fetch(`https://alfa-leetcode-api.onrender.com/${encodeURIComponent(username)}/solved`);
    if (!resp.ok) throw new Error(`LeetCode API error ${resp.status}`);
    const data = await resp.json();

    const solved = data.solvedProblem ?? 0;
    const total = data.totalQuestions ?? 0;
    const easy = data.easySolved ?? 0, easyTotal = data.totalEasy ?? 0;
    const med = data.mediumSolved ?? 0, medTotal = data.totalMedium ?? 0;
    const hard = data.hardSolved ?? 0, hardTotal = data.totalHard ?? 0;

    $('lcSolved').textContent = solved;
    $('lcTotal').textContent = total;
    $('lcTotalFill').style.width = pct(solved, total) + '%';

    $('lcEasyLabel').textContent = `${easy}/${easyTotal}`;
    $('lcEasyFill').style.width = pct(easy, easyTotal) + '%';
    $('lcMedLabel').textContent = `${med}/${medTotal}`;
    $('lcMedFill').style.width = pct(med, medTotal) + '%';
    $('lcHardLabel').textContent = `${hard}/${hardTotal}`;
    $('lcHardFill').style.width = pct(hard, hardTotal) + '%';

    await updateDailyGoalRing(solved, goal);

    lcProgress.classList.remove('hidden');
    lcStatus.textContent = `Synced for ${username}.`;
  } catch (e) {
    lcStatus.textContent = `Error: ${e.message}`;
  }
}

// The LeetCode API only reports lifetime totals, so "solved today" is tracked
// locally: the first sync of each day snapshots the current total as a
// baseline, and today's count is the delta above that baseline.
async function updateDailyGoalRing(totalSolved, goal) {
  const today = new Date().toISOString().slice(0, 10);
  const { dailyBaseline } = await chrome.storage.local.get('dailyBaseline');

  let baseline = dailyBaseline;
  if (!baseline || baseline.date !== today || totalSolved < baseline.solved) {
    baseline = { date: today, solved: totalSolved };
    await chrome.storage.local.set({ dailyBaseline: baseline });
  }

  const solvedToday = Math.max(0, totalSolved - baseline.solved);
  const ringPct = pct(solvedToday, goal);

  $('lcGoalSolved').textContent = solvedToday;
  $('lcGoalTarget').textContent = goal;
  lcRing.style.strokeDasharray = `${LC_RING_CIRCUMFERENCE}`;
  lcRing.style.strokeDashoffset = `${LC_RING_CIRCUMFERENCE * (1 - ringPct / 100)}`;
}

function pct(n, d) {
  if (!d) return 0;
  return Math.max(0, Math.min(100, Math.round((n / d) * 100)));
}

// ---------- user settings (LeetCode username + daily goal) ----------
const settingsPanel = $('settings');

$('settingsToggleBtn').onclick = () => settingsPanel.classList.toggle('hidden');

$('settingsSaveBtn').onclick = async () => {
  const username = $('settingsLcUsername').value.trim();
  const goal = parseInt($('settingsDailyGoal').value, 10);
  const dailyGoal = Number.isFinite(goal) && goal > 0 ? goal : DEFAULT_DAILY_GOAL;
  $('settingsDailyGoal').value = dailyGoal;

  if (!username) {
    $('settingsStatus').textContent = 'Enter a LeetCode username.';
    return;
  }

  await chrome.storage.local.set({ leetcodeUsername: username, dailyGoal });
  $('settingsStatus').textContent = 'Saved.';
  fetchLeetCodeStats(username, dailyGoal);
  settingsPanel.classList.add('hidden');
};

// ---------- follow-up chat ----------
$('sendBtn').onclick = sendFollowUp;
$('followUp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp(); }
});

function sendFollowUp() {
  const text = $('followUp').value.trim();
  if (!text) return;
  $('followUp').value = '';
  // Include current code as context on the first message if history is empty
  const code = codeBox.value.trim();
  const content = messages.length === 0 && code
    ? text + '\n\nCode:\n```\n' + code + '\n```'
    : text;
  sendToAI(content, text);
}

$('clearCodeBtn').onclick = () => {
  codeBox.value = '';
  captureInfo.textContent = 'Code box cleared.';
};

// ---------- OpenAI (streaming) ----------
async function sendToAI(content, displayText) {
  if (busy) return;
  if (!settings.apiKey) {
    captureInfo.textContent = 'Add OPENAI_API_KEY to the .env file in the extension folder.';
    return;
  }
  busy = true;
  setButtons(false);

  addMessage('user', displayText);
  messages.push({ role: 'user', content });
  const assistantBubble = addMessage('assistant', '');
  assistantBubble.innerHTML = '<span class="spinner"></span>';

  let full = '';
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey,
      },
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `API error ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const data = line.replace(/^data: /, '').trim();
        if (!data || data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            assistantBubble.innerHTML = renderMarkdown(full);
            chatEl.scrollTop = chatEl.scrollHeight;
          }
        } catch { /* partial JSON chunk; ignored */ }
      }
    }

    if (!full) throw new Error('Empty response from the API.');
    messages.push({ role: 'assistant', content: full });
    // Trim history to bound token usage
    if (messages.length > 20) messages = messages.slice(-20);
  } catch (e) {
    assistantBubble.innerHTML = '<span class="error">Error: ' + escapeHtml(e.message) + '</span>';
    messages.pop(); // remove the failed user turn so retry works cleanly
  } finally {
    busy = false;
    setButtons(true);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
}

function setButtons(enabled) {
  ['debugBtn', 'explainBtn', 'optimizeBtn', 'sendBtn', 'captureBtn'].forEach(
    (id) => ($(id).disabled = !enabled)
  );
}

// ---------- rendering ----------
function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'You' : 'Code Companion';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (text) bubble.innerHTML = renderMarkdown(text);
  wrap.append(who, bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Minimal markdown renderer: fenced code, inline code, bold, italics, headers, lists.
function renderMarkdown(md) {
  const codeBlocks = [];
  // Pull out fenced code first so other rules don't touch it.
  // Sentinels use Unicode private-use chars that won't appear in normal text.
  let text = md.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    codeBlocks.push('<pre><code>' + escapeHtml(code) + '</code></pre>');
    return '' + (codeBlocks.length - 1) + '';
  });

  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\. (.*)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> runs in <ul>
  text = text.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');
  // Paragraph breaks
  text = text
    .split(/\n{2,}/)
    .map((p) => (/^\s*(<(h\d|ul|pre)|)/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>'))
    .join('');

  // Restore code blocks
  return text.replace(/(\d+)/g, (_, i) => codeBlocks[+i]);
}
