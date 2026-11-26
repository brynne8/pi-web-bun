import { buildAtMentionText } from "./file-fuzzy.ts";
import { encodeFilePathForApi } from "./file-paths.ts";
import { errorMessage } from "./errors.ts";

/** Browser side of `POST /api/files/[...path]?type=upload`; mirrors `lib/file-upload.ts`. */
export type UploadConflictStrategy = "error" | "overwrite" | "skip";

export interface UploadError {
  name: string;
  error: string;
}

export interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

/**
 * Uploads files into one directory through the file API.
 * @param targetDirectory The directory the files are written to
 * @param files The files, written under their own names
 * @param strategy What the server does with a name that already exists
 * @param onProgress Upload progress in percent, when the browser reports it
 * @returns The HTTP status and the parsed response body
 */
export function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress?: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

/** One file or folder dropped onto the chat. */
export type DroppedItem = { kind: "file"; file: File } | { kind: "folder"; name: string };

/**
 * Sorts a chat drop: images are attached to the prompt as before, other files
 * are uploaded into the working directory and mentioned, and folders are left
 * out because the upload endpoint takes files only.
 * @param items The dropped items, in drop order
 * @returns The images, the files to upload, and the names of skipped folders
 */
export function splitDroppedItems(items: DroppedItem[]): { images: File[]; files: File[]; folders: string[] } {
  const images: File[] = [];
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    if (item.kind === "folder") folders.push(item.name);
    else if (item.file.type.startsWith("image/")) images.push(item.file);
    else files.push(item.file);
  }
  return { images, files, folders };
}

/**
 * The `@` mentions for files now in the working directory, in drop order.
 * @param files The dropped files
 * @param present Names the upload reports as written or already there
 * @returns Mentions ready to insert, or an empty string
 */
export function dropMentionText(files: File[], present: string[]): string {
  const names = new Set(present);
  return files
    .filter((file) => names.has(file.name))
    .map((file) => buildAtMentionText(file.name, false))
    .join("");
}

/**
 * Files dropped or picked into the chat: images attach to the prompt, everything else
 * uploads into the working directory — never replacing a file already there — and comes
 * back as @mentions. The composer's attach button takes this same path, for phones that
 * cannot drop files.
 */
export interface DroppedFilesDeps {
  /** The working directory the files land in, when the page has one. */
  cwd: string | null;
  uploadFiles: (targetDirectory: string, files: File[], strategy: UploadConflictStrategy) => Promise<UploadResponse & { status: number; data: UploadResponse }>;
  dropMentionText: (files: File[], present: string[]) => string | null;
  addNotice: (notice: { type: "error" | "warning" | "success" | "info"; message: string }) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  insertText?: (text: string) => void;
  onFilesUploaded?: () => void;
}

export async function uploadDroppedFiles(files: File[], deps: DroppedFilesDeps): Promise<void> {
  if (!deps.cwd) {
    deps.addNotice({ type: "warning", message: deps.t("chat.dropNeedsCwd") });
    return;
  }
  try {
    const { status, data } = await deps.uploadFiles(deps.cwd, files, "skip");
    const body = data ?? {};
    if (status !== 200 && status !== 207) throw new Error(body.error ?? `HTTP ${status}`);
    const uploaded = body.uploaded ?? [];
    const skipped = body.skipped ?? [];
    const mentions = deps.dropMentionText(files, [...uploaded, ...skipped]);
    if (mentions) deps.insertText?.(mentions);
    if (uploaded.length > 0) {
      deps.addNotice({ type: "success", message: deps.t("chat.dropUploaded", { count: uploaded.length }) });
      deps.onFilesUploaded?.();
    }
    if (skipped.length > 0) {
      deps.addNotice({ type: "warning", message: deps.t("chat.dropAlreadyExists", { names: skipped.join(", ") }) });
    }
    for (const failure of body.errors ?? []) {
      deps.addNotice({ type: "error", message: deps.t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
    }
  } catch (uploadError) {
    deps.addNotice({ type: "error", message: deps.t("chat.dropFailed", { message: errorMessage(uploadError) }) });
  }
}
