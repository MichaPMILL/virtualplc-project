// Bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('studioHost', {
  kind: 'electron',
  platform: process.platform,
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('api', method, args),
  openFile: (kind: string) => ipcRenderer.invoke('files.open', kind),
  saveFile: (path: string | null, text: string, suggestedName: string) => ipcRenderer.invoke('files.save', path, text, suggestedName),
  setDirty: (dirty: boolean) => ipcRenderer.send('app.dirty', dirty),
  setTitle: (title: string) => ipcRenderer.send('app.title', title),
  quit: () => ipcRenderer.send('app.quit'),
  onMenu: (cb: (action: string) => void) => ipcRenderer.on('menu', (_e, action: string) => cb(action)),
});
