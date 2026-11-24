import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** Integration boundary: swap for an S3-compatible provider in production. */
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  url(key: string): string;
  remove(key: string): Promise<void>;
}

export class LocalStorage implements StorageProvider {
  constructor(private dir = path.resolve(config.UPLOAD_DIR)) {}
  async put(key: string, data: Buffer) {
    const f = path.join(this.dir, key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }
  url(key: string) { return `${config.PUBLIC_URL}/media/${key}`; }
  async remove(key: string) { await fs.rm(path.join(this.dir, key), { force: true }); }
  get root() { return this.dir; }
}
export const storage = new LocalStorage();
