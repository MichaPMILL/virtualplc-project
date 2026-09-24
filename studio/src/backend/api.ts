// The API exposed to the renderer (Electron IPC or HTTP in web mode).
// Every method takes JSON-serialisable arguments and returns a promise.
import { Backend } from './backend.ts';
import * as git from './git.ts';
import { folderForNewProject, openProjectPath, saveProjectPath, type ProjectLayout } from './projectStore.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_EXT, safeFileName, setSimulatorWasm } from '../../../sdk/src/index.ts';

// dist/vplc-sim.wasm, next to the bundled backend (main.cjs in Electron, backend.mjs in web mode)
declare const __dirname: string | undefined;
setSimulatorWasm(join(typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)), 'vplc-sim.wasm'));

export function createApi(backend = new Backend()) {
  return {
    compile: (projectJson: string, deviceId: string) => backend.compile(projectJson, deviceId),
    connect: (deviceId: string, host: string, port: number, password?: string) => backend.connect(deviceId, host, port, password),
    disconnect: (deviceId: string) => backend.disconnect(deviceId),
    state: (deviceId: string) => backend.state(deviceId),
    download: (deviceId: string, startAfter: boolean) => backend.download(deviceId, startAfter),
    start: (deviceId: string, cold: boolean) => backend.start(deviceId, cold),
    stop: (deviceId: string) => backend.stop(deviceId),
    logs: (deviceId: string, from: number) => backend.logs(deviceId, from),
    read: (deviceId: string, paths: string[]) => backend.read(deviceId, paths),
    write: (deviceId: string, path: string, text: string) => backend.write(deviceId, path, text),
    force: (deviceId: string, path: string, value: boolean | null) => backend.force(deviceId, path, value),
    unforceAll: (deviceId: string) => backend.unforceAll(deviceId),
    dataLogRead: (deviceId: string, log: number, count: number, before?: number) => backend.dataLogRead(deviceId, log, count, before),
    dataLogTest: (deviceId: string, log: number) => backend.dataLogTest(deviceId, log),
    setSecret: (deviceId: string, key: string, value: string) => backend.setSecret(deviceId, key, value),
    traceCertificate: (deviceId: string, log: number, max: number) => backend.traceCertificate(deviceId, log, max),
    /** Serial ports of this computer (USB CPUs: ESP32, Arduino…) */
    serialPorts: async (): Promise<Array<{ path: string; label: string }>> => {
      try {
        const { SerialPort } = await import('serialport');
        const ports = await SerialPort.list();
        return ports.map((p) => ({ path: p.path, label: [p.manufacturer, p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : ''].filter(Boolean).join(' ') }));
      } catch {
        return [];
      }
    },

    // Project files
    projectOpen: (path: string) => openProjectPath(path),
    projectSave: (path: string, projectJson: string, layout: ProjectLayout) => saveProjectPath(path, projectJson, layout),
    /** New folder project from a chosen "<dir>/<Name>.vplcproj" (a sub-folder is created when needed). */
    projectSaveAs: async (chosenFile: string, projectJson: string, name: string) => {
      const dir = await folderForNewProject(chosenFile, name);
      return saveProjectPath(join(dir, `${safeFileName(name)}${MANIFEST_EXT}`), projectJson, 'folder');
    },

    // Version management (folder projects)
    gitStatus: (dir: string) => git.gitStatus(dir),
    gitInit: (dir: string) => git.gitInit(dir),
    gitSetUser: (dir: string, name: string, email: string) => git.gitSetUser(dir, name, email),
    gitCommit: (dir: string, message: string) => git.gitCommit(dir, message),
    gitLog: (dir: string, limit?: number, all?: boolean) => git.gitLog(dir, limit, all),
    gitTag: (dir: string, name: string, message: string, rev?: string) => git.gitTag(dir, name, message, rev),
    gitProjectAt: (dir: string, rev: string) => git.gitProjectAt(dir, rev),
    gitDiff: (dir: string, from?: string, to?: string) => git.gitDiff(dir, from, to),
    gitSetRemote: (dir: string, url: string, name?: string) => git.gitSetRemote(dir, url, name),
    gitRemotes: (dir: string) => git.gitRemotes(dir),
    gitAddRemote: (dir: string, name: string, url: string) => git.gitAddRemote(dir, name, url),
    gitEditRemote: (dir: string, name: string, newName: string, url: string) => git.gitEditRemote(dir, name, newName, url),
    gitRemoveRemote: (dir: string, name: string) => git.gitRemoveRemote(dir, name),
    gitCreateSharedRepo: (path: string) => git.gitCreateSharedRepo(path),
    gitFetch: (dir: string) => git.gitFetch(dir),
    gitSync: (dir: string, remote?: string) => git.gitSync(dir, remote),
    gitBranches: (dir: string) => git.gitBranches(dir),
    gitCreateBranch: (dir: string, name: string, from?: string, switchTo?: boolean) => git.gitCreateBranch(dir, name, from, switchTo),
    gitSwitch: (dir: string, name: string) => git.gitSwitch(dir, name),
    gitMergeBranch: (dir: string, ref: string) => git.gitMergeBranch(dir, ref),
    gitDeleteBranch: (dir: string, name: string, force?: boolean, remote?: boolean) => git.gitDeleteBranch(dir, name, force, remote),
    gitResolve: (dir: string, path: string, side: 'mine' | 'theirs') => git.gitResolve(dir, path, side),
    gitFinishMerge: (dir: string) => git.gitFinishMerge(dir),
    gitAbortMerge: (dir: string) => git.gitAbortMerge(dir),
    gitClone: async (url: string, parent: string) => openProjectPath(await git.gitClone(url, parent)),
    gitArchive: (dir: string, rev: string, output: string) => git.gitArchive(dir, rev, output),
  };
}

export type StudioApi = ReturnType<typeof createApi>;
export type ApiMethod = keyof StudioApi;
