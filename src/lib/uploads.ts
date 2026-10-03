/**
 * Ceiling on a single uploaded file, chosen to sit below the whole stack of
 * platform limits so this check is the one that actually rejects an oversized
 * file, instead of an opaque 413 from further up:
 *
 *   MAX_UPLOAD_BYTES (3mb)
 *     < serverActions.bodySizeLimit (4mb, next.config.mjs)   — 10-20kb of
 *     < Vercel request body limit (4.5mb Node / 4mb Edge)     multipart
 *                                                              overhead + form fields
 *
 * Raising this past ~3.7mb reintroduces files that pass this check and then
 * fail at the edge with no useful error for the user.
 */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

type AllowedMimeType = "application/pdf" | "image/jpeg" | "image/png";

/**
 * Extensions are bound to the content type they must actually carry. Without
 * this link a PDF named `id.png` would pass both allowlists independently and
 * later be served under an image name, which reopens content-type confusion
 * in the browser and in Appwrite's CDN.
 */
const ALLOWED_UPLOAD_TYPES_BY_EXTENSION: Record<
  string,
  readonly AllowedMimeType[]
> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
};

export const ALLOWED_UPLOAD_EXTENSIONS = Object.keys(
  ALLOWED_UPLOAD_TYPES_BY_EXTENSION
).sort() as readonly string[];

export const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024;

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

const FILE_SIGNATURES: { mime: AllowedMimeType; bytes: number[] }[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

export const detectMimeType = async (
  blob: Blob
): Promise<AllowedMimeType | null> => {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());

  const match = FILE_SIGNATURES.find((signature) =>
    signature.bytes.every((byte, index) => head[index] === byte)
  );

  return match?.mime ?? null;
};

const extensionOf = (fileName: string) =>
  `.${(fileName.split(".").pop() ?? "").toLowerCase()}`;

/**
 * Validates an upload on the server. The declared MIME type and file name are
 * both attacker-controlled, so the only trustworthy signal is the file's own
 * magic bytes — every check below fails closed.
 */
export const validateUpload = async (blob: Blob, fileName: string) => {
  const extension = extensionOf(fileName);
  const permittedMimeTypes = ALLOWED_UPLOAD_TYPES_BY_EXTENSION[extension];

  if (!permittedMimeTypes) {
    throw new UploadValidationError(
      `Unsupported file type. Allowed extensions: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.`
    );
  }

  if (blob.size === 0) {
    throw new UploadValidationError("The uploaded file is empty.");
  }

  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(
      `The uploaded file exceeds the ${MAX_UPLOAD_MEGABYTES}MB limit.`
    );
  }

  const detectedMimeType = await detectMimeType(blob);

  if (!detectedMimeType || !permittedMimeTypes.includes(detectedMimeType)) {
    throw new UploadValidationError(
      `${fileName} does not contain valid ${extension} data. Accepted formats: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.`
    );
  }

  return detectedMimeType;
};