const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "readerd",
  Object.freeze({
    openPdf: () => ipcRenderer.invoke("readerd:open-pdf"),
    rendererReady: () => ipcRenderer.invoke("readerd:renderer-ready"),
    onOpenPdf: (callback) => {
      const listener = (_event, file) => callback(file);
      ipcRenderer.on("readerd:open-file", listener);
      return () => ipcRenderer.removeListener("readerd:open-file", listener);
    },
    onOpenError: (callback) => {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on("readerd:open-error", listener);
      return () => ipcRenderer.removeListener("readerd:open-error", listener);
    },
    savePdf: (input) => ipcRenderer.invoke("readerd:save-pdf", input),
    loadState: (path) => ipcRenderer.invoke("readerd:load-state", path),
    saveState: (path, state) =>
      ipcRenderer.invoke("readerd:save-state", path, state),
    getProfile: () => ipcRenderer.invoke("readerd:get-profile"),
    saveProfile: (markdown) =>
      ipcRenderer.invoke("readerd:save-profile", markdown),
    getSettings: () => ipcRenderer.invoke("readerd:get-settings"),
    saveSettings: (settings) =>
      ipcRenderer.invoke("readerd:save-settings", settings),
    testAI: (settings) => ipcRenderer.invoke("readerd:test-ai", settings),
    requestAI: (request) => ipcRenderer.invoke("readerd:request-ai", request),
    windowAction: (action) =>
      ipcRenderer.invoke("readerd:window-action", action),
    openExternal: (url) => ipcRenderer.invoke("readerd:open-external", url),
    openReference: (reference) =>
      ipcRenderer.invoke("readerd:open-reference", reference),
    onBeforeClose: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("readerd:before-close", listener);
      return () => ipcRenderer.removeListener("readerd:before-close", listener);
    },
  }),
);
