import * as sdk from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import type { Appointment } from "@/types/appwrite.types";

import { env } from "../env";
import { registerJobHandler } from "../job-queue";
import type { JobHandlerCtx } from "../job-queue";
import { enqueueSms } from "../sms-outbox";

/**
 * PDF invoices, generated off the request path.
 *
 * Booking enqueues an `invoice.generate` job (deterministic id
 * `invoice-<appointmentId>`, so an appointment gets one invoice). When the
 * drain cron picks the job up it builds a PDF with no native dependency (the
 * builder below writes a minimal, valid single-page PDF using Helvetica and a
 * content stream), uploads it to the document bucket, logs the creation to the
 * audit ledger, and queues an SMS telling the patient it exists. The upload
 * cost, the file write, and the notification all happen outside the booking
 * request that started them.
 */

export type InvoiceLineItem = {
  description: string;
  amountCents: number;
};

export type InvoiceData = {
  invoiceNumber: string;
  issuedAt: string;
  patientName: string;
  physicianName: string;
  schedule: string;
  amountCents: number;
  lineItems?: InvoiceLineItem[];
};

const escapePdfText = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e]/g, "?");

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Builds a minimal valid PDF: a catalog, one page, Helvetica, and a text
 * stream. No fonts are embedded and the text is ASCII-only, which keeps the
 * output deterministic and dependency-free. Document structure is standard
 * (version header, xref table, trailer), so any PDF reader can open it.
 */
export const createInvoicePdf = (invoice: InvoiceData): Buffer => {
  const lines = [
    { text: "CarePulse", size: 22 },
    { text: `Invoice ${invoice.invoiceNumber}`, size: 13 },
    { text: `Issued ${invoice.issuedAt}`, size: 9 },
    { text: "", size: 12 },
    { text: `Patient: ${invoice.patientName}`, size: 12 },
    { text: `Physician: Dr. ${invoice.physicianName}`, size: 12 },
    { text: `Appointment: ${invoice.schedule}`, size: 12 },
    ...(invoice.lineItems ?? [{ description: "Consultation", amountCents: invoice.amountCents }]).map(
      (item) => ({
        text: `${item.description}  ..........  ${money(item.amountCents)}`,
        size: 12,
      })
    ),
    { text: "", size: 12 },
    { text: `Amount due: ${money(invoice.amountCents)}`, size: 14 },
  ];

  const streamParts = ["BT\n"];
  let y = 780;

  for (const line of lines) {
    if (line.text) {
      streamParts.push(
        `BT /F1 ${line.size} Tf 50 ${y} Td (${escapePdfText(line.text)}) Tj ET\n`
      );
    }
    y -= 32;
  }

  const stream = Buffer.from(streamParts.join(""), "ascii");

  const chunks: Buffer[] = [];
  const offsets = [0];
  let offset = 0;

  const pushObject = (body: string | Buffer) => {
    offsets[chunks.length] = offset;
    const buffer =
      typeof body === "string" ? Buffer.from(body, "ascii") : body;
    chunks.push(buffer);
    offset += buffer.length;
  };

  pushObject(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  pushObject(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  pushObject(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`
  );
  pushObject(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`);
  pushObject(stream);
  pushObject(`endstream\nendobj\n`);
  pushObject(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  const xrefOffset = offset;
  const xref = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    ...[1, 2, 3, 4, 5].map(
      (index) => `${String(offsets[index]).padStart(10, "0")} 00000 n `
    ),
    "trailer",
    "<< /Size 6 /Root 1 0 R >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  return Buffer.concat([
    Buffer.from("%PDF-1.4\n", "ascii"),
    ...chunks,
    Buffer.from(xref, "ascii"),
  ]);
};

export const appointmentInvoiceNumber = (appointmentId: string) =>
  `INV-${appointmentId.replace(/\W/g, "").slice(0, 8).toUpperCase()}`;

const patientNameForAppointment = async (
  appointment: Appointment,
  databases: JobHandlerCtx["databases"]
) => {
  if (typeof appointment.patient === "object" && appointment.patient?.name) {
    return appointment.patient.name;
  }

  const patientId =
    typeof appointment.patient === "string"
      ? appointment.patient
      : appointment.patient?.$id;

  if (!patientId) return "Patient";

  try {
    const patient = (await databases.getDocument(
      env.DATABASE_ID,
      env.PATIENT_COLLECTION_ID,
      patientId
    )) as unknown as { name: string };

    return patient.name ?? "Patient";
  } catch {
    return "Patient";
  }
};

export const invoiceDataForAppointment = async (
  appointment: Appointment,
  ctx: JobHandlerCtx
): Promise<InvoiceData> => ({
  invoiceNumber: appointmentInvoiceNumber(appointment.$id),
  issuedAt: ctx.now.toISOString(),
  patientName: await patientNameForAppointment(appointment, ctx.databases),
  physicianName: appointment.primaryPhysician,
  schedule: new Date(appointment.schedule).toISOString(),
  amountCents: 0,
});

/**
 * Generates the invoice for one appointment: PDF -> storage upload -> audit ->
 * patient SMS. Runs only inside a drained job, never in the booking request.
 */
export const generateAppointmentInvoice = async ({
  appointmentId,
}: {
  appointmentId: string;
}, ctx: JobHandlerCtx): Promise<{ fileId: string }> => {
  const appointment = (await ctx.databases.getDocument(
    env.DATABASE_ID,
    env.APPOINTMENT_COLLECTION_ID,
    appointmentId
  )) as Appointment;

  const pdf = createInvoicePdf(await invoiceDataForAppointment(appointment, ctx));
  const invoiceNumber = appointmentInvoiceNumber(appointmentId);
  const uploaded = await ctx.storage.createFile(
    env.NEXT_PUBLIC_BUCKET_ID,
    sdk.ID.unique(),
    InputFile.fromBuffer(pdf, `invoice-${appointmentId}.pdf`),
    [],
    "invoices"
  );

  await ctx.audit({
    action: "document.create",
    resourceType: "document",
    resourceId: uploaded.$id,
    actorRole: "system",
    actorId: "job-queue",
    detail: `Generated ${invoiceNumber} for appointment ${appointmentId}.`,
  });

  await enqueueSms(
    {
      userId: appointment.userId,
      content: `Your CarePulse ${invoiceNumber} is ready to view.`,
      dedupeKey: `invoice-notify:${appointmentId}`,
    },
    ctx
  );

  return { fileId: uploaded.$id };
};

registerJobHandler("invoice.generate", async (job, ctx) => {
  const payload = JSON.parse(job.payload) as { appointmentId?: string };

  if (!payload.appointmentId) {
    throw new Error(`invoice.generate job missing appointmentId (${job.$id})`);
  }

  const { fileId } = await generateAppointmentInvoice(
    { appointmentId: payload.appointmentId },
    ctx
  );

  return { result: JSON.stringify({ fileId }) };
});