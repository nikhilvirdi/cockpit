import { EXCLUDED_DIRECTORIES, isAnalysisInput } from '../../core/src/sourceKinds';

export interface ScannedFile {
  relativePath: string;
  file: File;
}

export interface FolderHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FolderHandle | { kind: 'file'; name: string; getFile(): Promise<File> }>;
}

export async function walkDirectoryHandle(
  dirHandle: FolderHandle,
  currentPath = ''
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory') {
      if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
        const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        const subFiles = await walkDirectoryHandle(entry, nextPath);
        files.push(...subFiles);
      }
    } else if (entry.kind === 'file') {
      if (isAnalysisInput(entry.name)) {
        const file = await entry.getFile();
        const relPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        files.push({ relativePath: relPath, file });
      }
    }
  }

  return files;
}

export function filterFileList(fileList: FileList): ScannedFile[] {
  const files: ScannedFile[] = [];

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const rawPath = file.webkitRelativePath || file.name;
    const parts = rawPath.replace(/\\/g, '/').split('/');

    // Strip top-level selected folder name if present in webkitRelativePath
    const pathParts = parts.length > 1 ? parts.slice(1) : parts;

    const isExcluded = pathParts.slice(0, -1).some(dir => EXCLUDED_DIRECTORIES.has(dir.toLowerCase()));
    if (isExcluded) continue;

    const fileName = pathParts[pathParts.length - 1];
    if (isAnalysisInput(fileName)) {
      files.push({
        relativePath: pathParts.join('/'),
        file
      });
    }
  }

  return files;
}
