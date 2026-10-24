'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const util = require('node:util');

const marker = 'NODE_SNIFTER_TRACE:';
let writing = false;

function emit(category, action, detail = {}) {
  if (writing) return;
  writing = true;
  try {
    const event = {
      timestamp: new Date().toISOString(),
      category,
      action,
      detail: clean(detail),
    };
    process.stderr.write(`${marker}${JSON.stringify(event)}\n`);
  } catch {
    // Tracing must never change the behavior of the observed program.
  } finally {
    writing = false;
  }
}

function clean(value, depth = 0) {
  if (depth > 2) return '[nested]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'string') return value.slice(0, 500);
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => clean(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 10)) {
      if (/authorization|cookie|password|token|secret/i.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = clean(item, depth + 1);
      }
    }
    return result;
  }
  return util.inspect(value, { depth: 0, maxStringLength: 120 });
}

function wrap(object, key, category, describe) {
  const original = object[key];
  if (typeof original !== 'function' || original.__nodeSnifferWrapped) return;
  function traced(...args) {
    try {
      emit(category, key, describe(args));
    } catch {
      // Ignore trace formatting errors.
    }
    return Reflect.apply(original, this, args);
  }
  Object.defineProperty(traced, '__nodeSnifferWrapped', { value: true });
  object[key] = traced;
}

const pathFor = (args) => ({ path: typeof args[0] === 'string' ? args[0] : util.inspect(args[0]) });
for (const name of [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'copyFile',
  'copyFileSync', 'exists', 'existsSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync',
  'mkdtemp', 'mkdtempSync', 'open', 'openSync', 'readFile', 'readFileSync', 'readdir',
  'readdirSync', 'rename', 'renameSync', 'rm', 'rmSync', 'stat', 'statSync', 'symlink',
  'symlinkSync', 'unlink', 'unlinkSync', 'writeFile', 'writeFileSync', 'createReadStream',
  'createWriteStream',
]) {
  wrap(fs, name, 'file', pathFor);
}
for (const name of [
  'access', 'appendFile', 'chmod', 'copyFile', 'lstat', 'mkdir', 'mkdtemp', 'open',
  'readFile', 'readdir', 'rename', 'rm', 'stat', 'symlink', 'unlink', 'writeFile',
]) {
  wrap(fsp, name, 'file', pathFor);
}

function describeRequest(args) {
  const input = args[0];
  const options = typeof input === 'object' && input !== null ? input : args[1] || {};
  let host = options.hostname || options.host || 'localhost';
  let path = options.path || '/';
  if (typeof input === 'string' || input instanceof URL) {
    try {
      const url = new URL(input);
      host = url.host;
      path = url.pathname;
    } catch {
      path = String(input).split('?')[0];
    }
  }
  return { method: options.method || 'GET', host, path: String(path).split('?')[0] };
}

for (const client of [http, https]) {
  for (const name of ['request', 'get']) {
    wrap(client, name, 'network', describeRequest);
  }
}
if (typeof globalThis.fetch === 'function') {
  wrap(globalThis, 'fetch', 'network', ([input, options = {}]) => {
    let url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    try {
      const parsed = new URL(url);
      url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      url = url.split('?')[0];
    }
    return { method: options.method || 'GET', url };
  });
}

for (const name of ['exec', 'execFile', 'fork', 'spawn']) {
  wrap(childProcess, name, 'process', (args) => ({
    command: String(args[0]).slice(0, 200),
    argumentCount: Array.isArray(args[1]) ? args[1].length : 0,
  }));
}

for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  wrap(console, name, 'console', (args) => ({
    level: name,
    message: util.format(...args).slice(0, 1000),
  }));
}

process.on('uncaughtExceptionMonitor', (error) => emit('error', 'uncaughtException', error));
process.on('unhandledRejection', (reason) => emit('error', 'unhandledRejection', reason));
process.on('exit', (code) => emit('lifecycle', 'exit', { code }));
emit('lifecycle', 'started', { pid: process.pid, node: process.version, script: process.argv[1] });