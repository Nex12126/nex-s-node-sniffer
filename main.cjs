'use strict';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let windowRef;
let child;
let stderrBuffer = '';
let attachedInspector;

function publish(channel, value) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, value);
}

function publishOutput(stream, text) {
  if (text) publish('trace:event', {
    timestamp: new Date().toISOString(),
    category: 'output',
    action: stream,
    detail: { message: text },
  });
}

function parseArguments(value) {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
}

function listNodeProcesses() {
  const command = [
    '$ErrorActionPreference = "Stop"',
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'"',
    '| Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, WorkingSetSize',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error('Could not read the local process list.'));
      const output = stdout.replace(/^\uFEFF/, '').trim();
      if (!output) return resolve([]);
      let entries;
      try {
        entries = JSON.parse(output);
      } catch {
        return reject(new Error('The local process list returned an invalid format.'));
      }
      const processes = (Array.isArray(entries) ? entries : [entries]).map((entry) => {
        const commandLine = entry.CommandLine || '';
        const inspectMatch = commandLine.match(/--inspect(?:-brk)?(?:=([^"\s]+))?/i);
        let inspectorPort = null;
        if (inspectMatch) {
          const inspectValue = inspectMatch[1] || '';
          const portMatch = inspectValue.match(/:(\d+)$/) || inspectValue.match(/^(\d+)$/);
          inspectorPort = portMatch ? Number(portMatch[1]) : 9229;
          if (!inspectorPort) inspectorPort = null;
        }
        const scriptMatch = commandLine.match(/(?:"([^"\r\n]+\.(?:js|cjs|mjs))"|([^\s]+\.(?:js|cjs|mjs)))/i);
        const scriptPath = scriptMatch?.[1] || scriptMatch?.[2] || '';
        return {
          pid: Number(entry.ProcessId),
          parentPid: Number(entry.ParentProcessId),
          executablePath: entry.ExecutablePath || '',
          scriptName: scriptPath ? path.basename(scriptPath) : '(script name unavailable)',
          memoryMb: Math.round(Number(entry.WorkingSetSize || 0) / 1024 / 1024),
          inspectorPort,
        };
      });
      resolve(processes);
    });
  });
}

async function getInspectorTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('The Node Inspector is not responding.');
  const targets = await response.json();
  const target = targets.find((item) => item.webSocketDebuggerUrl);
  if (!target) throw new Error('The Node Inspector did not provide a debug target.');
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname)) {
    throw new Error('The Inspector is not bound to loopback.');
  }
  return socketUrl.toString();
}

async function attachToInspector(processInfo) {
  if (attachedInspector) throw new Error('A process is already connected.');
  const socketUrl = await getInspectorTarget(processInfo.inspectorPort);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let ready = false;
    let nextId = 0;
    const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++nextId, method, params }));

    socket.addEventListener('open', () => {
      ready = true;
      attachedInspector = { socket, pid: processInfo.pid };
      send('Runtime.enable');
      send('Debugger.enable');
      send('Network.enable');
      send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 });
      publish('trace:state', { running: true, pid: processInfo.pid, attached: true });
      resolve({ pid: processInfo.pid });
    });
    socket.addEventListener('message', ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const args = message.params.args.map((item) => item.value ?? item.description ?? item.type);
        publish('trace:event', {
          timestamp: new Date().toISOString(),
          category: 'console',
          action: message.params.type,
          detail: { message: args.map(String).join(' ').slice(0, 1000), pid: processInfo.pid },
        });
      } else if (message.method === 'Runtime.exceptionThrown') {
        const error = message.params.exceptionDetails;
        publish('trace:event', {
          timestamp: new Date().toISOString(),
          category: 'error',
          action: 'exception',
          detail: { message: error.text, url: error.url, line: error.lineNumber + 1, pid: processInfo.pid },
        });
      } else if (message.method === 'Network.requestWillBeSent') {
        let url = message.params.request.url;
        try {
          const parsed = new URL(url);
          url = `${parsed.origin}${parsed.pathname}`;
        } catch {
          url = url.split('?')[0];
        }
        publish('trace:event', {
          timestamp: new Date().toISOString(),
          category: 'network',
          action: 'request',
          detail: { method: message.params.request.method, url, pid: processInfo.pid },
        });
      }
    });
    socket.addEventListener('error', () => {
      const error = new Error('The Node Inspector connection failed.');
      if (!ready) reject(error);
      else publish('trace:error', error.message);
    });
    socket.addEventListener('close', () => {
      if (attachedInspector?.socket === socket) {
        attachedInspector = null;
        publish('trace:state', { running: false, attached: true });
      }
    });
  });
}

function consumeStderr(chunk) {
  stderrBuffer += chunk.toString();
  const lines = stderrBuffer.split(/\r?\n/);
  stderrBuffer = lines.pop() || '';
  for (const line of lines) {
    if (line.startsWith('NODE_SNIFTER_TRACE:')) {
      try {
        publish('trace:event', JSON.parse(line.slice('NODE_SNIFTER_TRACE:'.length)));
      } catch {
        publishOutput('stderr', line);
      }
    } else {
      publishOutput('stderr', line);
    }
  }
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'sniffer.ico')
    : path.join(__dirname, 'sniffer.ico');
  windowRef = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#101614',
    title: 'Node Sniffer',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.loadFile(path.join(__dirname, 'index.html'));
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

ipcMain.handle('trace:pick-script', async () => {
  const result = await dialog.showOpenDialog(windowRef, {
    title: 'Choose a Node.js script',
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js', 'cjs', 'mjs'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('trace:pick-node', async () => {
  const result = await dialog.showOpenDialog(windowRef, {
    title: 'Choose Node.js executable',
    properties: ['openFile'],
    filters: [{ name: 'Node.js', extensions: ['exe'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('process:list', async () => listNodeProcesses());

ipcMain.handle('process:attach', async (_event, pid) => {
  const processes = await listNodeProcesses();
  const processInfo = processes.find((item) => item.pid === Number(pid));
  if (!processInfo) throw new Error('The Node process is no longer running.');
  if (!processInfo.inspectorPort) {
    throw new Error('This process has no active Node Inspector. System stats are available, but JavaScript tracing is not enabled.');
  }
  return attachToInspector(processInfo);
});

ipcMain.handle('trace:start', (_event, options) => {
  if (child || attachedInspector) throw new Error('A trace is already running.');
  if (!options?.scriptPath || !fs.existsSync(options.scriptPath)) {
    throw new Error('Choose an existing JavaScript file.');
  }
  const extension = path.extname(options.scriptPath).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(extension)) {
    throw new Error('Supported file types are .js, .cjs, and .mjs.');
  }

  const tracerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'trace-agent.cjs')
    : path.join(__dirname, 'trace-agent.cjs');
  const executable = options.nodeExecutable?.trim() || 'node';
  const args = ['--require', tracerPath, options.scriptPath, ...parseArguments(options.scriptArgs || '')];
  stderrBuffer = '';
  child = spawn(executable, args, {
    cwd: path.dirname(options.scriptPath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => publishOutput('stdout', chunk.toString()));
  child.stderr.on('data', consumeStderr);
  child.on('error', (error) => {
    publish('trace:error', error.message);
    child = null;
    publish('trace:state', { running: false });
  });
  child.on('close', (code, signal) => {
    if (stderrBuffer) {
      if (stderrBuffer.startsWith('NODE_SNIFTER_TRACE:')) {
        try {
          publish('trace:event', JSON.parse(stderrBuffer.slice('NODE_SNIFTER_TRACE:'.length)));
        } catch {
          publishOutput('stderr', stderrBuffer);
        }
      } else {
        publishOutput('stderr', stderrBuffer);
      }
      stderrBuffer = '';
    }
    child = null;
    publish('trace:state', { running: false, code, signal });
  });
  publish('trace:state', { running: true, pid: child.pid, scriptPath: options.scriptPath });
  return { pid: child.pid };
});

ipcMain.handle('trace:stop', () => {
  if (child) child.kill();
  if (attachedInspector) {
    attachedInspector.socket.close();
    attachedInspector = null;
    publish('trace:state', { running: false, detached: true });
  }
});

ipcMain.handle('trace:save', async (_event, events) => {
  const result = await dialog.showSaveDialog(windowRef, {
    title: 'Export trace',
    defaultPath: 'node-sniffer-trace.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!result.canceled) fs.writeFileSync(result.filePath, JSON.stringify(events, null, 2), 'utf8');
  return !result.canceled;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (child) child.kill();
  if (attachedInspector) attachedInspector.socket.close();
  if (process.platform !== 'darwin') app.quit();
});