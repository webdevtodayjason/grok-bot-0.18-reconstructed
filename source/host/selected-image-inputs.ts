import { readFile } from "node:fs/promises";
import { attachmentImageMimeFromPath } from "../shared/media/image-mime.js";
export interface SelectedImageInput { data: Uint8Array<ArrayBuffer>; path: string; mimeType: string | undefined }
export async function loadSelectedImageInputs(attachmentPaths: readonly string[]): Promise<SelectedImageInput[]> {
  if (attachmentPaths.length === 0) return [];
  const loaded = await Promise.all(attachmentPaths.map(async (path): Promise<SelectedImageInput | null> => {
    try {
      const file = await readFile(path);
      const data = Uint8Array.from(file);
      // The same resolver the splitter used to decide this file was a picture at all, so a .heic
      // that reaches here does not then arrive carrying no media type.
      return { data, path, mimeType: attachmentImageMimeFromPath(path) };
    } catch {
      return null;
    }
  }));
  return loaded.filter((image): image is SelectedImageInput => image !== null);
}
