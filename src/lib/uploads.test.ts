/**
 * Upload validation.
 *
 * The declared MIME type and the file name both arrive from the client, so the
 * only trustworthy signal is the file's own magic bytes. The disguised-file cases
 * below are the actual attack: a PHP or SVG payload renamed to `.jpg` and served
 * back under an image content type.
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  detectMimeType,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MEGABYTES,
  UploadValidationError,
  validateUpload,
} from "./uploads";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0];

const blobOf = (bytes: number[], type = "image/jpeg") =>
  new Blob([new Uint8Array(bytes)], { type });

const rejects = async (
  bytes: number[],
  fileName: string,
  type = "image/jpeg"
): Promise<unknown> => {
  const attempt = validateUpload(blobOf(bytes, type), fileName);

  await expect(attempt).rejects.toBeInstanceOf(UploadValidationError);

  return attempt.catch((error: unknown) => error);
};

describe("validateUpload accepts genuine files", () => {
  it("accepts a real PNG", async () => {
    expect(await validateUpload(blobOf(PNG, "image/png"), "id.png")).toBe(
      "image/png"
    );
  });

  it("accepts real JPEGs under both extensions", async () => {
    expect(await validateUpload(blobOf(JPEG), "id.jpg")).toBe("image/jpeg");
    expect(await validateUpload(blobOf(JPEG), "id.jpeg")).toBe("image/jpeg");
  });

  it("accepts a real PDF", async () => {
    expect(
      await validateUpload(blobOf(PDF, "application/pdf"), "id.pdf")
    ).toBe("application/pdf");
  });
});

describe("validateUpload rejects disguised files", () => {
  it("refuses a PHP payload renamed to .jpg", async () => {
    await rejects([0x3c, 0x3f, 0x70, 0x68, 0x70, 0x20], "id.jpg");
  });

  it("refuses a PDF header followed by PNG bytes", async () => {
    await rejects([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "id.png", "image/png");
  });

  it("refuses an SVG renamed to .png", async () => {
    await rejects([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78], "id.png", "image/png");
  });

  it("refuses HTML renamed to .jpg", async () => {
    await rejects([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e], "id.jpg");
  });
});

describe("validateUpload binds extension to content", () => {
  it("refuses an unlisted extension", async () => {
    await rejects(JPEG, "id.gif", "image/gif");
  });

  it("refuses a file with no extension", async () => {
    await rejects(JPEG, "id");
  });

  it("refuses every cross-format pairing", async () => {
    await rejects(PNG, "id.jpg", "image/jpeg");
    await rejects(PDF, "id.png", "image/png");
    await rejects(PNG, "id.pdf", "application/pdf");
  });

  it("exposes an allowlist that matches the validator", () => {
    expect(ALLOWED_UPLOAD_EXTENSIONS).toEqual([".jpeg", ".jpg", ".pdf", ".png"]);
  });
});

describe("validateUpload enforces size", () => {
  it("refuses an empty file", async () => {
    await rejects([], "id.png", "image/png");
  });

  it("refuses a file over the limit", async () => {
    const oversized = new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)], {
      type: "image/png",
    });

    await expect(validateUpload(oversized, "id.png")).rejects.toBeInstanceOf(
      UploadValidationError
    );
  });

  it("keeps the limit under the platform body ceiling", () => {
    // See the note in uploads.ts: this check has to be the one that rejects, or
    // the user gets an opaque 413 from further up the stack.
    expect(MAX_UPLOAD_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_UPLOAD_MEGABYTES).toBe(3);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("content wins over a lying declared type", () => {
  it("refuses PHP bytes even when the blob claims image/png", async () => {
    await rejects([0x3c, 0x3f, 0x70, 0x68, 0x70], "id.png", "image/png");
  });
});

describe("detectMimeType", () => {
  it("identifies each supported signature", async () => {
    expect(await detectMimeType(blobOf(PNG, "image/png"))).toBe("image/png");
    expect(await detectMimeType(blobOf(JPEG))).toBe("image/jpeg");
    expect(await detectMimeType(blobOf(PDF, "application/pdf"))).toBe(
      "application/pdf"
    );
  });

  it("returns null for unrecognised bytes", async () => {
    expect(await detectMimeType(blobOf([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it("returns null for an empty blob", async () => {
    expect(await detectMimeType(blobOf([]))).toBeNull();
  });
});