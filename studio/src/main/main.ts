// Electron main process of VirtualPLC Studio.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createApi, type ApiMethod } from '../backend/api.ts';

const api = createApi();
let win: BrowserWindow | null = null;
let dirty = false;

const FILTERS = {
  project: [{ name: 'Projet VirtualPLC', extensions: ['vplcproj'] }, { name: 'Projet VirtualPLC 1.x (JSON)', extensions: ['json'] }],
  scl: [{ name: 'Fichiers exportés (sources SCL, DB, types, tables de variables, export XML)', extensions: ['scl', 'db', 'udt', 'xlsx', 'xml', 'txt'] }],
  zip: [{ name: 'Archive ZIP', extensions: ['zip'] }],
  iodd: [{ name: 'Description IO-Link (IODD)', extensions: ['xml'] }],
  gsdml: [{ name: 'Description PROFINET (GSDML)', extensions: ['xml'] }],
};

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    title: 'VirtualPLC Studio',
    backgroundColor: '#f0f0f0',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  // External links open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!dirty || !win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      title: 'VirtualPLC Studio',
      message: 'Voulez-vous enregistrer les modifications du projet ?',
    });
    if (choice === 2) e.preventDefault();
    else if (choice === 0) {
      e.preventDefault();
      win.webContents.send('menu', 'project.saveAndQuit');
    }
  });
}

// The UI draws its own menu bar; on macOS a minimal native menu keeps the usual shortcuts.
function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown[]) => {
  const fn = api[method] as (...a: unknown[]) => unknown;
  if (typeof fn !== 'function') throw new Error(`Unknown method ${String(method)}`);
  return fn(...args);
});

ipcMain.handle('files.openMany', async (_e, kind?: 'iodd' | 'gsdml') => {
  if (!win) return [];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: kind ? FILTERS[kind] : FILTERS.scl });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(async (path) => ({ path, name: basename(path), bytes: new Uint8Array(await readFile(path)) })));
});

ipcMain.handle('files.pick', async (_e, kind: 'openProject' | 'saveProject' | 'folder' | 'zip', suggested?: string) => {
  if (!win) return null;
  if (kind === 'openProject') {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS.project });
    return r.canceled ? null : r.filePaths[0] ?? null;
  }
  if (kind === 'folder') {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: suggested });
    return r.canceled ? null : r.filePaths[0] ?? null;
  }
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested, filters: kind === 'zip' ? FILTERS.zip : FILTERS.project });
  if (r.canceled || !r.filePath) return null;
  const ext = kind === 'zip' ? '.zip' : '.vplcproj';
  return r.filePath.endsWith(ext) ? r.filePath : `${r.filePath}${ext}`;
});

ipcMain.on('app.dirty', (_e, value: boolean) => {
  dirty = value;
  win?.setDocumentEdited(value);
});
ipcMain.on('app.title', (_e, title: string) => win?.setTitle(title));
ipcMain.on('app.quit', () => {
  dirty = false;
  win?.close();
});

app.whenReady().then(() => {
  installMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
