import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  toggleAlwaysOnTop: () => ipcRenderer.send('window/toggle-always-on-top'),
  close: () => ipcRenderer.send('window/close'),
});