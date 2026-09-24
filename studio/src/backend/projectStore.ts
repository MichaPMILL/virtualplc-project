// Reading and writing projects on disk: folder projects (one file per object, made for
// Git) and single-file projects (.vplcproj, and VirtualPLC 1.x .json files).
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  isFolderManifest, isManagedPath, loadProject, MANIFEST_EXT, projectFromFiles, projectToFiles, safeFileName, saveProject,
  type ProjectFiles,
} from '../../../sdk/src/index.ts';

export type ProjectLayout = 'folder' | 'file';

export interface OpenedProject {
  /** Manifest (folder project) or project file */
  path: string;
  /** Project folder (folder layout) */
  dir: string | null;
  layout: ProjectLayout;
  json: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await listFiles(join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

/** Reads the project files of a folder (only the files the Studio manages). */
export async function readProjectFolder(dir: string): Promise<ProjectFiles> {
  const files: ProjectFiles = {};
  for (const path of await listFiles(dir)) {
    if (isManagedPath(path)) files[path] = await readFile(join(dir, path), 'utf8');
  }
  return files;
}

export async function openProjectPath(path: string): Promise<OpenedProject> {
  let target = resolve(path);
  if ((await stat(target)).isDirectory()) {
    const manifest = (await readdir(target)).find((f) => f.endsWith(MANIFEST_EXT));
    if (!manifest) throw new Error(`Aucun projet VirtualPLC (${MANIFEST_EXT}) dans le dossier ${target}`);
    target = join(target, manifest);
  }
  const text = await readFile(target, 'utf8');
  if (isFolderManifest(text)) {
    const dir = dirname(target);
    const project = projectFromFiles(await readProjectFolder(dir));
    return { path: target, dir, layout: 'folder', json: JSON.stringify(project) };
  }
  return { path: target, dir: null, layout: 'file', json: text };
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch {
    // new file
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  while (dir.startsWith(root) && dir !== root) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Writes a folder project: changed files only, and removes files of deleted/renamed objects. */
export async function writeProjectFolder(dir: string, projectJson: string): Promise<string> {
  const files = projectToFiles(loadProject(projectJson));
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const existing = (await listFiles(root)).filter(isManagedPath);
  for (const [path, content] of Object.entries(files)) {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new Error(`Invalid project path ${path}`);
    // .gitattributes / .gitignore are created once, then belong to the user
    if (path.startsWith('.git') && existing.length) {
      try {
        await stat(file);
        continue;
      } catch {
        // missing: create it
      }
    }
    await writeIfChanged(file, content);
  }
  for (const path of existing) {
    if (files[path] === undefined) {
      await unlink(join(root, path));
      await removeEmptyDirs(dirname(join(root, path)), root);
    }
  }
  return join(root, Object.keys(files).find((p) => p.endsWith(MANIFEST_EXT))!);
}

/**
 * Folder for a new folder project chosen as "<dir>/<Name>.vplcproj": the chosen folder
 * when it is empty or already holds this project, otherwise a sub-folder named after the project.
 */
export async function folderForNewProject(chosenFile: string, projectName: string): Promise<string> {
  const dir = dirname(resolve(chosenFile));
  const name = safeFileName(basename(chosenFile, extname(chosenFile)) || projectName);
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((e) => !e.startsWith('.'));
  } catch {
    return dir;
  }
  if (entries.length === 0 || entries.some((e) => e.endsWith(MANIFEST_EXT)) && basename(dir) === name) return dir;
  return join(dir, name);
}

export async function saveProjectPath(path: string, projectJson: string, layout: ProjectLayout): Promise<OpenedProject> {
  if (layout === 'folder') {
    const manifestDir = dirname(resolve(path));
    const manifest = await writeProjectFolder(manifestDir, projectJson);
    return { path: manifest, dir: manifestDir, layout, json: projectJson };
  }
  const text = saveProject(loadProject(projectJson));
  await writeIfChanged(resolve(path), text);
  return { path: resolve(path), dir: null, layout, json: text };
}
