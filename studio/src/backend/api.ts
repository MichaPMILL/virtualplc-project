// The API exposed to the renderer (Electron IPC or HTTP in web mode).
// Every method takes JSON-serialisable arguments and returns a promise.
import { Backend } from './backend.ts';
import * as git from './git.ts';
import { folderForNewProject, openProjectPath, saveProjectPath, type ProjectLayout } from './projectStore.ts';
import { dirname, join } from 'node:path';
import { MANIFEST_EXT, safeFileName } from '../../../sdk/src/index.ts';

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
    gitLog: (dir: string, limit?: number) => git.gitLog(dir, limit),
    gitTag: (dir: string, name: string, message: string, rev?: string) => git.gitTag(dir, name, message, rev),
    gitProjectAt: (dir: string, rev: string) => git.gitProjectAt(dir, rev),
    gitDiff: (dir: string, from?: string, to?: string) => git.gitDiff(dir, from, to),
    gitSetRemote: (dir: string, url: string) => git.gitSetRemote(dir, url),
    gitSync: (dir: string) => git.gitSync(dir),
    gitResolve: (dir: string, path: string, side: 'mine' | 'theirs') => git.gitResolve(dir, path, side),
    gitFinishMerge: (dir: string) => git.gitFinishMerge(dir),
    gitAbortMerge: (dir: string) => git.gitAbortMerge(dir),
    gitClone: async (url: string, parent: string) => openProjectPath(await git.gitClone(url, parent)),
    gitArchive: (dir: string, rev: string, output: string) => git.gitArchive(dir, rev, output),
    dirname: async (path: string) => dirname(path),
  };
}

export type StudioApi = ReturnType<typeof createApi>;
export type ApiMethod = keyof StudioApi;
