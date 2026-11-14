import JSZip from 'jszip';
import type { ScannedFile } from './folderScanner';

export function createZipBundle(files: ScannedFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const { relativePath, file } of files) zip.file(relativePath, file);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
