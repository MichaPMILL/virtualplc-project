// Access to the host: Electron (preload bridge) or the development web server.
import type { StudioApi, ApiMethod } from '../backend/api.ts';

export interface OpenedFile {
  path: string;
  name: string;
  text: string;
}

interface HostBridge {
  kind: 'electron' | 'web';
  platform: string;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  openFile(kind: 'project' | 'scl'): Promise<OpenedFile | null>;
  saveFile(path: string | null, text: string, suggestedName: string): Promise<string | null>;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  quit(): void;
  onMenu(cb: (action: string) => void): void;
}

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
    openFile(kind) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = kind === 'project' ? '.vplcproj,.json' : '.scl,.txt';
        input.onchange = async () => {
          const f = input.files?.[0];
          resolve(f ? { path: f.name, name: f.name, text: await f.text() } : null);
        };
        input.click();
      });
    },
    async saveFile(path, text, suggestedName) {
      const name = path ?? suggestedName;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name.endsWith('.vplcproj') ? name : `${name}.vplcproj`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return a.download;
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
