'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sniffer', {
  pickScript: () => ipcRenderer.invoke('trace:pick-script'),
  pickNode: () => ipcRenderer.invoke('trace:pick-node'),
  listProcesses: () => ipcRenderer.invoke('process:list'),
  attach: (pid) => ipcRenderer.invoke('process:attach', pid),
  start: (options) => ipcRenderer.invoke('trace:start', options),
  stop: () => ipcRenderer.invoke('trace:stop'),
  save: (events) => ipcRenderer.invoke('trace:save', events),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('trace:event', listener);
    return () => ipcRenderer.removeListener('trace:event', listener);
  },
  onState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('trace:state', listener);
    return () => ipcRenderer.removeListener('trace:state', listener);
  },
  onError: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('trace:error', listener);
    return () => ipcRenderer.removeListener('trace:error', listener);
  },
});