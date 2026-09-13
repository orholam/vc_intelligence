import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "./config.js";

/**
 * Raw extracted-text storage (FR-4): S3-compatible (MinIO in dev) or local
 * filesystem driver. Objects are referenced by articles.extracted_text_path.
 */
export interface Storage {
  put(key: string, body: string | Uint8Array): Promise<string>; // returns ref
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

function parseRef(ref: string): { driver: "s3" | "local"; key: string } {
  const m = /^([a-z]+):\/\/(.+)$/.exec(ref);
  if (!m) throw new Error(`bad storage ref: ${ref}`);
  return { driver: m[1] === "s3" ? "s3" : "local", key: decodeURIComponent(m[2] ?? "") };
}

export class LocalStorage implements Storage {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const p = path.resolve(this.baseDir, key);
    if (!p.startsWith(path.resolve(this.baseDir))) throw new Error("path traversal blocked");
    return p;
  }

  async put(key: string, body: string | Uint8Array): Promise<string> {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return `local://${key}`;
  }

  async get(ref: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(parseRef(ref).key), "utf8");
    } catch {
      return null;
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(parseRef(ref).key));
    } catch {
      /* already gone */
    }
  }
}

export class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;

  constructor(endpoint: string | undefined, region: string, bucket: string, accessKeyId: string, secretAccessKey: string) {
    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: Boolean(endpoint),
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, body: string | Uint8Array): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body),
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }

  async get(ref: string): Promise<string | null> {
    try {
      const { key } = parseRef(ref);
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes).toString("utf8") : null;
    } catch {
      return null;
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      const { key } = parseRef(ref);
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      /* idempotent */
    }
  }
}

export function makeStorage(cfg = getConfig()): Storage {
  if (cfg.STORAGE_DRIVER === "s3") {
    if (!cfg.S3_ACCESS_KEY_ID) throw new Error("STORAGE_DRIVER=s3 requires S3 credentials");
    return new S3Storage(
      cfg.S3_ENDPOINT,
      cfg.S3_REGION,
      cfg.S3_BUCKET,
      cfg.S3_ACCESS_KEY_ID,
      cfg.S3_SECRET_ACCESS_KEY,
    );
  }
  return new LocalStorage(cfg.LOCAL_STORAGE_DIR);
}
