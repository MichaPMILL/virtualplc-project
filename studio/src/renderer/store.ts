// Application state. Components subscribe to change notifications.
import type { Block, DataTypeDef, Device, Project, ProjectDiagnostic, SymbolNode, TagTable, WatchTable } from '../../../sdk/src/browser.ts';
import type { CompileSummary } from '../backend/backend.ts';
import type { GitStatus } from '../backend/git.ts';

export type EditorRef =
  | { kind: 'overview' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'online'; deviceId: string }
  | { kind: 'tagTable'; deviceId: string; tableId: string }
  | { kind: 'allTags'; deviceId: string }
  | { kind: 'block'; deviceId: string; blockId: string }
  | { kind: 'watch'; deviceId: string; tableId: string }
  | { kind: 'dataType'; deviceId: string; typeId: string }
  | { kind: 'history' }
  | { kind: 'branches' };

export interface Message {
  severity: 'error' | 'warning' | 'info' | 'ok';
  text: string;
  path?: string;
  time: string;
  goto?: EditorRef & { line?: number; network?: number; element?: string };
}

export interface OnlineState {
  connected: boolean;
  state?: 'NO_PROGRAM' | 'STOP' | 'RUN' | 'FAULT';
  programId?: string | null;
  offlineProgramId?: string | null;
  scanUs?: number;
  maxScanUs?: number;
  cycleMs?: number;
  forces?: number;
  fault?: { code: string; function: number; line: number; pc: number } | null;
  io?: Array<{ module: number; ok: boolean }>;
  logs: Array<{ seq: number; t: number; msg: string }>;
  host?: string;
}

type Listener = (topic: Topic) => void;
export type Topic = 'project' | 'editors' | 'selection' | 'online' | 'messages' | 'compile' | 'monitor' | 'layout' | 'git';

class Store {
  project: Project | null = null;
  filePath: string | null = null;
  /** 'folder': one file per object (versionable with Git); 'file': single .vplcproj file */
  fileLayout: 'folder' | 'file' | null = null;
  /** Folder of a folder project */
  projectDir: string | null = null;
  /** Version management state of the project folder */
  git: GitStatus | null = null;
  dirty = false;
  editors: EditorRef[] = [];
  active: EditorRef | null = null;
  selection: { kind: string; id?: string; deviceId?: string } | null = null;
  messages: Message[] = [];
  compile = new Map<string, CompileSummary>();
  online = new Map<string, OnlineState>();
  monitoring = false;
  layout = { tree: true, tasks: true, inspector: true };
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(topic: Topic): void {
    for (const l of this.listeners) l(topic);
  }

  touch(): void {
    this.dirty = true;
    this.emit('project');
  }

  device(id?: string): Device | undefined {
    return this.project?.devices.find((d) => d.id === id) ?? this.project?.devices[0];
  }

  block(deviceId: string, blockId: string): Block | undefined {
    return this.device(deviceId)?.blocks.find((b) => b.id === blockId);
  }

  tagTable(deviceId: string, tableId: string): TagTable | undefined {
    return this.device(deviceId)?.tagTables.find((t) => t.id === tableId);
  }

  dataType(deviceId: string, typeId: string): DataTypeDef | undefined {
    return this.device(deviceId)?.types.find((x) => x.id === typeId);
  }

  watchTable(deviceId: string, tableId: string): WatchTable | undefined {
    return this.device(deviceId)?.watchTables.find((t) => t.id === tableId);
  }

  onlineOf(deviceId: string): OnlineState {
    let s = this.online.get(deviceId);
    if (!s) {
      s = { connected: false, logs: [] };
      this.online.set(deviceId, s);
    }
    return s;
  }

  get anyOnline(): boolean {
    return [...this.online.values()].some((s) => s.connected);
  }

  symbols(deviceId: string): SymbolNode[] {
    return this.compile.get(deviceId)?.symbols ?? [];
  }

  diagnosticsFor(blockId: string): ProjectDiagnostic[] {
    const out: ProjectDiagnostic[] = [];
    for (const c of this.compile.values()) out.push(...c.diagnostics.filter((d) => d.blockId === blockId));
    return out;
  }

  addMessage(m: Omit<Message, 'time'>): void {
    this.messages.push({ ...m, time: new Date().toLocaleTimeString() });
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    this.emit('messages');
  }
}

export const store = new Store();

export function sameEditor(a: EditorRef, b: EditorRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
