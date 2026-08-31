const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openOpusTelemetry', Object.freeze({
  getContext: () => ipcRenderer.invoke('open-opus-telemetry:get-context'),
  captureFeedback: (feedback) => ipcRenderer.invoke('open-opus-telemetry:capture-feedback', feedback),
}));

contextBridge.exposeInMainWorld('openOpusYouTube', Object.freeze({
  getStatus: () => ipcRenderer.invoke('open-opus-youtube:get-status'),
  signIn: () => ipcRenderer.invoke('open-opus-youtube:sign-in'),
  signOut: () => ipcRenderer.invoke('open-opus-youtube:sign-out'),
}));
