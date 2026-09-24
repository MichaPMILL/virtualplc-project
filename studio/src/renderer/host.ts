// Access to the host: Electron (preload bridge) or the development web server.
import type { StudioApi, ApiMethod } from '../backend/api.ts';
import { promptDialog } from './ui/dialogs.ts';

export interface OpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

interface HostBridge {
  kind: 'electron' | 'web';
  platform: string;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  /** Files exported by engineering tools (.scl, .db, .udt, .xlsx) */
  openFiles(): Promise<OpenedFile[]>;
  /** Native file/folder chooser; returns an absolute path on this computer */
  pickPath(kind: PathKind, suggested?: string): Promise<string | null>;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  quit(): void;
  onMenu(cb: (action: string) => void): void;
}

export type PathKind = 'openProject' | 'saveProject' | 'folder' | 'zip';

declare global {
  interface Window {
    studioHost?: HostBridge;
  }
}

function webHost(): HostBridge {
  return {
    kind: 'web',
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'other',
    async invoke(method, args) {
      const res = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    },
    openFiles() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.scl,.db,.udt,.xlsx,.txt';
        input.onchange = async () => {
          resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ path: f.name, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
        };
        input.click();
      });
    },
    // Web (development) mode: the backend runs on this computer, paths are typed in
    pickPath(kind, suggested) {
      const label = {
        openProject: 'Chemin du projet (.vplcproj ou dossier)', saveProject: 'Chemin du projet (.vplcproj)',
        folder: 'Dossier', zip: "Chemin de l'archive (.zip)",
      }[kind];
      return promptDialog('Chemin sur ce poste', label, suggested ?? '');
    },
    setDirty() {},
    setTitle(title) {
      document.title = title;
    },
    quit() {},
    onMenu() {},
  };
}

export const host: HostBridge = window.studioHost ?? webHost();

/** Typed call of a backend method. */
export function call<M extends ApiMethod>(method: M, ...args: Parameters<StudioApi[M]>): Promise<Awaited<ReturnType<StudioApi[M]>>> {
  return host.invoke(method, args) as Promise<Awaited<ReturnType<StudioApi[M]>>>;
}
