'use strict';

const events = [];
let activeFilter = 'all';
let running = false;

const elements = {
  scriptPath: document.querySelector('#script-path'),
  nodePath: document.querySelector('#node-path'),
  scriptArgs: document.querySelector('#script-args'),
  start: document.querySelector('#start-button'),
  stop: document.querySelector('#stop-button'),
  list: document.querySelector('#event-list'),
  empty: document.querySelector('#empty-state'),
  search: document.querySelector('#search-input'),
  summary: document.querySelector('#event-summary'),
  visibleCount: document.querySelector('#visible-count'),
  runtimeLabel: document.querySelector('#runtime-label'),
  runtimeDetail: document.querySelector('#runtime-detail'),
  indicator: document.querySelector('#runtime-indicator'),
  export: document.querySelector('#export-button'),
  toast: document.querySelector('#toast'),
  processesButton: document.querySelector('#processes-button'),
  processPanel: document.querySelector('#process-panel'),
  processList: document.querySelector('#process-list'),
  processSummary: document.querySelector('#process-summary'),
};

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove('visible'), 3200);
}

function setRunning(value, state = {}) {
  running = value;
  elements.start.disabled = value || !elements.scriptPath.value;
  elements.stop.disabled = !value;
  elements.scriptPath.disabled = value;
  elements.processesButton.disabled = value;
  elements.runtimeLabel.textContent = value ? (state.attached ? 'Inspector connected' : 'Trace active') : 'Ready';
  elements.runtimeDetail.textContent = value ? `PID ${state.pid ?? '...'}` : 'No script running';
  elements.indicator.classList.toggle('live', value);
  if (state.detached) elements.runtimeDetail.textContent = 'Disconnected';
  if (state.code !== undefined) elements.runtimeDetail.textContent = `Exited with code ${state.code}`;
  if (state.signal) elements.runtimeDetail.textContent = `Exited (${state.signal})`;
}

function renderProcesses(processes) {
  elements.processList.replaceChildren();
  elements.processSummary.textContent = `${processes.length} local Node.js processes`;
  if (!processes.length) {
    const empty = document.createElement('div');
    empty.className = 'process-empty';
    empty.textContent = 'No running node.exe processes found';
    elements.processList.append(empty);
    return;
  }

  for (const processInfo of processes) {
    const row = document.createElement('div');
    row.className = 'process-row';
    const pid = document.createElement('span');
    pid.className = 'process-pid';
    pid.textContent = processInfo.pid;
    const script = document.createElement('span');
    script.className = 'process-script';
    script.textContent = processInfo.scriptName;
    script.title = processInfo.executablePath;
    const memory = document.createElement('span');
    memory.className = 'process-memory';
    memory.textContent = `${processInfo.memoryMb} MB`;
    const action = document.createElement('button');
    action.className = 'attach-button';
    action.textContent = processInfo.inspectorPort ? `Connect :${processInfo.inspectorPort}` : 'Inspector off';
    action.disabled = !processInfo.inspectorPort || running;
    action.title = processInfo.inspectorPort
      ? 'Connect to this Node Inspector'
      : 'JavaScript tracing requires the process to be started with --inspect';
    action.addEventListener('click', async () => {
      try {
        await window.sniffer.attach(processInfo.pid);
        showToast(`Connected to PID ${processInfo.pid}.`);
      } catch (error) {
        showToast(error.message);
      }
    });
    row.append(pid, script, memory, action);
    elements.processList.append(row);
  }
}

async function refreshProcesses() {
  elements.processSummary.textContent = 'Loading processes';
  try {
    renderProcesses(await window.sniffer.listProcesses());
  } catch (error) {
    elements.processSummary.textContent = 'Process list unavailable';
    showToast(error.message);
  }
}

function stringifyDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (detail?.message) return detail.message;
  return Object.entries(detail || {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('  ·  ');
}

function makeEventRow(event) {
  const row = document.createElement('article');
  row.className = `event-row category-${event.category}`;
  const date = new Date(event.timestamp);
  const time = Number.isNaN(date.getTime()) ? '--:--:--.---' : date.toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  });
  const timeCell = document.createElement('time');
  timeCell.textContent = time;
  const category = document.createElement('span');
  category.className = 'category-tag';
  category.textContent = event.category;
  const content = document.createElement('div');
  content.className = 'event-content';
  const action = document.createElement('strong');
  action.textContent = event.action;
  const detail = document.createElement('span');
  detail.textContent = stringifyDetail(event.detail);
  content.append(action, detail);
  row.append(timeCell, category, content);
  return row;
}

function render() {
  const query = elements.search.value.trim().toLowerCase();
  const filtered = events.filter((event) => {
    const matchesCategory = activeFilter === 'all' || event.category === activeFilter;
    const haystack = `${event.category} ${event.action} ${stringifyDetail(event.detail)}`.toLowerCase();
    return matchesCategory && haystack.includes(query);
  });
  elements.list.replaceChildren();
  if (events.length === 0) {
    elements.list.append(elements.empty);
  } else if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-results';
    empty.textContent = 'No matching events';
    elements.list.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const event of filtered.slice(-500).reverse()) fragment.append(makeEventRow(event));
    elements.list.append(fragment);
  }
  elements.visibleCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'event' : 'events'}`;
  elements.summary.textContent = events.length ? `${events.length} collected` : 'Waiting for a script';
  elements.export.disabled = events.length === 0;
  for (const category of ['all', 'lifecycle', 'console', 'file', 'network', 'process', 'error', 'output']) {
    const count = category === 'all' ? events.length : events.filter((event) => event.category === category).length;
    document.querySelector(`#count-${category}`).textContent = count;
  }
}

document.querySelector('#script-button').addEventListener('click', async () => {
  const selected = await window.sniffer.pickScript();
  if (!selected) return;
  elements.scriptPath.value = selected;
  document.querySelector('#cwd-hint').textContent = selected.split(/[\\/]/).slice(0, -1).join('\\');
  elements.start.disabled = running ? true : false;
});

document.querySelector('#node-button').addEventListener('click', async () => {
  const selected = await window.sniffer.pickNode();
  if (selected) elements.nodePath.value = selected;
});

elements.start.addEventListener('click', async () => {
  try {
    await window.sniffer.start({
      scriptPath: elements.scriptPath.value,
      nodeExecutable: elements.nodePath.value,
      scriptArgs: elements.scriptArgs.value,
    });
  } catch (error) {
    showToast(error.message);
  }
});

elements.stop.addEventListener('click', () => window.sniffer.stop());
elements.processesButton.addEventListener('click', async () => {
  elements.processPanel.hidden = !elements.processPanel.hidden;
  if (!elements.processPanel.hidden) await refreshProcesses();
});
document.querySelector('#refresh-processes').addEventListener('click', refreshProcesses);
document.querySelector('#clear-button').addEventListener('click', () => {
  events.length = 0;
  render();
});
elements.search.addEventListener('input', render);
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
  render();
}));
elements.export.addEventListener('click', async () => {
  if (await window.sniffer.save(events)) showToast('Trace exported.');
});

window.sniffer.onEvent((event) => {
  events.push(event);
  render();
});
window.sniffer.onState((state) => setRunning(state.running, state));
window.sniffer.onError((message) => showToast(message));
render();