const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openOpusTelemetry', Object.freeze({
  getContext: () => ipcRenderer.invoke('open-opus-telemetry:get-context'),
  captureFeedback: (feedback) => ipcRenderer.invoke('open-opus-telemetry:capture-feedback', feedback),
}));
