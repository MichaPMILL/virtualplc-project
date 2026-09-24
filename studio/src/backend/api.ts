// The API exposed to the renderer (Electron IPC or HTTP in web mode).
// Every method takes JSON-serialisable arguments and returns a promise.
import { Backend } from './backend.ts';

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
  };
}

export type StudioApi = ReturnType<typeof createApi>;
export type ApiMethod = keyof StudioApi;
