const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openOpusTelemetry', Object.freeze({
  getContext: () => ipcRenderer.invoke('open-opus-telemetry:get-context'),
}));
