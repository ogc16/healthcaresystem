import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { getSession } from "@/lib/auth/guards";
import {
  canAccessDocument,
  getDocumentBytes,
  getPatientByUserId,
} from "@/lib/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Authenticated, authorized stream for an uploaded identification document.
 *
 * Documents are never served from a public Appwrite URL. This route is the only
 * way to fetch them, and it enforces the same ownership rule the rest of the
 * app does: a patient may fetch their own document, an admin may fetch any.
 */
export const GET = async (
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ fileId: string }>;
  }
) => {
  const { fileId } = await params;

  if (!fileId) {
    return NextResponse.json({ error: "Missing file id" }, { status: 400 });
  }

  const session = await getSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const patient =
    session.role === "patient" && session.userId
      ? await getPatientByUserId(session.userId)
      : undefined;

  if (!canAccessDocument(session, fileId, patient)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { name, mimeType, bytes } = await getDocumentBytes(fileId);

    await recordAudit({
      action: "document.read",
      resourceType: "document",
      resourceId: fileId,
      actorRole: session.role,
      actorId: session.userId ?? "admin",
      detail: `Streamed identification document "${name}".`,
    });

    return new Response(bytes, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }
};