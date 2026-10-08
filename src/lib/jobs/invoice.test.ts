import type { Databases, Messaging, Storage } from "node-appwrite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appointmentInvoiceNumber,
  createInvoicePdf,
  generateAppointmentInvoice,
} from "./invoice";

const fakeDatabase = () => {
  const createDocument = vi.fn();
  const updateDocument = vi.fn();
  const listDocuments = vi.fn();
  const getDocument = vi.fn();
  return { createDocument, updateDocument, listDocuments, getDocument };
};

const fakeStorage = () => ({ createFile: vi.fn() });

const fakeMessaging = () => ({ createSms: vi.fn() });

const asDatabases = (fake: ReturnType<typeof fakeDatabase>) =>
  fake as unknown as Databases;

const asStorage = (fake: ReturnType<typeof fakeStorage>) =>
  fake as unknown as Storage;

const asMessaging = (fake: ReturnType<typeof fakeMessaging>) =>
  fake as unknown as Messaging;

const ctx = {
  databases: asDatabases(fakeDatabase()),
  storage: asStorage(fakeStorage()),
  messaging: asMessaging(fakeMessaging()),
  audit: vi.fn(),
  now: new Date("2026-01-04T10:00:00.000Z"),
};

describe("appointmentInvoiceNumber", () => {
  it("derives a short, stable invoice id from the appointment id", () => {
    expect(appointmentInvoiceNumber("60f1abc2def3")).toBe("INV-60F1ABC2");
  });
});

describe("createInvoicePdf", () => {
  const pdf = createInvoicePdf({
    invoiceNumber: "INV-ABC123",
    issuedAt: "2026-01-04T10:00:00.000Z",
    patientName: "Carl Cancel",
    physicianName: "Evan Peter",
    schedule: "2026-01-05T14:00:00.000Z",
    amountCents: 12500,
  });

  it("produces a valid PDF envelope with the expected fields", () => {
    const text = pdf.toString("ascii");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("<< /Type /Catalog /Pages 2 0 R >>");
    expect(text).toContain("/MediaBox [0 0 595 842]");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("lays out the invoice content as PDF text", () => {
    const text = pdf.toString("ascii");
    expect(text).toContain("(CarePulse)");
    expect(text).toContain("(Invoice INV-ABC123)");
    expect(text).toContain("(Patient: Carl Cancel)");
    expect(text).toContain("(Physician: Dr. Evan Peter)");
    expect(text).toContain("(Amount due: $125.00)");
  });

  it("escapes PDF text metacharacters", () => {
    const escaped = createInvoicePdf({
      invoiceNumber: "INV-X",
      issuedAt: "d",
      patientName: "A (Parent) \\(Tricky\\) \\Back",
      physicianName: "Y",
      schedule: "s",
      amountCents: 0,
    }).toString("ascii");
    expect(escaped).toContain("\\(Parent\\)");
    expect(escaped).toContain("\\\\Back");
  });
});

describe("generateAppointmentInvoice", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BUCKET_ID;
    delete process.env.SMS_OUTBOX_COLLECTION_ID;
  });

  it("builds a PDF from the appointment, uploads it, audits, and notifies the patient", async () => {
    const databases = fakeDatabase();
    const storage = fakeStorage();
    const messaging = fakeMessaging();
    const audit = vi.fn();
    databases.getDocument.mockImplementation(async (_db, collection, id) => {
      if (collection === "appointments") {
        return {
          $id: "appt-1",
          primaryPhysician: "Evan Peter",
          schedule: "2026-01-05T14:00:00.000Z",
          userId: "user-9",
          patient: "pat-1",
        };
      }
      if (collection === "patients") {
        return { $id: id, name: "Carl Cancel" };
      }
      throw new Error(`unexpected collection ${collection}`);
    });
    storage.createFile.mockResolvedValue({ $id: "file-1", name: "invoice.pdf" });
    databases.listDocuments.mockResolvedValue({ total: 0, documents: [] });

    process.env.DATABASE_ID = "db";
    process.env.APPOINTMENT_COLLECTION_ID = "appointments";
    process.env.PATIENT_COLLECTION_ID = "patients";
    process.env.NEXT_PUBLIC_BUCKET_ID = "bucket";
    process.env.SMS_OUTBOX_COLLECTION_ID = "sms_outbox";

    const { fileId } = await generateAppointmentInvoice(
      { appointmentId: "appt-1" },
      {
        databases: asDatabases(databases),
        storage: asStorage(storage),
        messaging: asMessaging(messaging),
        audit,
        now: ctx.now,
      }
    );

    expect(fileId).toBe("file-1");

    // Uploaded PDF: name, folder, and real PDF bytes.
    const [, , fileArg] = storage.createFile.mock.calls[0];
    expect(fileArg.filename).toBe("invoice-appt-1.pdf");
    const bytes = Buffer.from(await fileArg.slice(0, await fileArg.size()));
    expect(bytes.toString("ascii", 0, 8)).toBe("%PDF-1.4");

    // The creation is entered into the audit ledger.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.create",
        resourceType: "document",
        actorRole: "system",
        resourceId: "file-1",
      })
    );

    // The patient is told the invoice exists, exactly once.
    expect(databases.createDocument).toHaveBeenCalledTimes(1);
    const [, , , smsData] = databases.createDocument.mock.calls[0];
    expect(smsData).toMatchObject({
      userId: "user-9",
      content: expect.stringContaining("INV-"),
      dedupeKey: "invoice-notify:appt-1",
    });
  });
});