// dur.io: the latest pictures of the user for the attach panel of the composer —
// "Pictures" and its "Screenshots" folder (Windows puts Win+PrtScn shots there),
// newest first. The page gets small thumbnails and opaque ids; a file is read only
// by an id from the latest listing, so the page cannot ask for any other path.
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { app, nativeImage } from "electron";

import { handleTrusted } from "./security";

const EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** How many pictures the panel shows */
const MAX_COUNT = 5;

/** Larger files are left out (the server takes 100 MB at most) */
const MAX_BYTES = 100 * 1024 * 1024;

/** Thumbnail edge in pixels */
const THUMBNAIL = 160;

/** Ids of the last listing → absolute paths */
let listed = new Map<string, string>();

export interface RecentImage {
  id: string;
  name: string;
  /** PNG data URL */
  thumbnail: string;
}

interface Picture {
  file: string;
  name: string;
  time: number;
}

/**
 * Picture files of a folder with their modification time
 * @param dir Folder
 */
async function picturesIn(dir: string) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch((): Dirent[] => []);
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          path.extname(entry.name).toLowerCase() in EXTENSIONS,
      )
      .map(async (entry): Promise<Picture | undefined> => {
        const file = path.join(dir, entry.name);
        const stat = await fs.stat(file).catch((): undefined => undefined);
        return stat && stat.size <= MAX_BYTES
          ? { file, name: entry.name, time: stat.mtimeMs }
          : undefined;
      }),
  );
  return files.filter((file): file is Picture => file !== undefined);
}

/**
 * The newest pictures with thumbnails
 * @returns Newest first
 */
async function recentImages(): Promise<RecentImage[]> {
  const pictures = app.getPath("pictures");
  const found = [
    ...(await picturesIn(pictures)),
    ...(await picturesIn(path.join(pictures, "Screenshots"))),
  ]
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_COUNT);

  const next = new Map<string, string>();
  const images: RecentImage[] = [];
  for (const { file, name } of found) {
    const image = await nativeImage
      .createThumbnailFromPath(file, { width: THUMBNAIL, height: THUMBNAIL })
      .catch(() =>
        nativeImage.createFromPath(file).resize({ height: THUMBNAIL }),
      );
    if (image.isEmpty()) continue;

    const id = randomUUID();
    next.set(id, file);
    images.push({ id, name, thumbnail: image.toDataURL() });
  }

  listed = next;
  return images;
}

/**
 * A listed picture: its bytes, name and type
 * @param id Id from the latest listing
 */
async function readRecentImage(id: unknown) {
  const file = typeof id === "string" ? listed.get(id) : undefined;
  if (!file) throw new Error("unknown picture");

  const data = await fs.readFile(file);
  return {
    name: path.basename(file),
    type: EXTENSIONS[path.extname(file).toLowerCase()],
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

export function initRecentImages() {
  handleTrusted("recentImages:list", () => recentImages());
  handleTrusted("recentImages:read", (_event, id: unknown) =>
    readRecentImage(id),
  );
}
