import { expect, test } from "@playwright/test";

import { resetMock, seedMock } from "./utils";

test("an admin session receives live audit events over SSE", async ({
  page,
}) => {
  await resetMock();
  await seedMock({
    user: {
      name: "Telemetry Patient",
      email: "telemetry@example.com",
      phone: "+1555100500",
      password: "telemetry-password",
    },
    patient: {
      name: "Telemetry Patient",
      email: "telemetry@example.com",
      phone: "+1555100500",
    },
    appointment: {
      primaryPhysician: "Evan Peter",
      schedule: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      reason: "Follow-up",
      status: "pending",
      note: "",
    },
  });

  // The admin passkey login is the same path the dashboard uses.
  await page.goto("/admin");
  await page.waitForURL(/\/admin\/login/);
  await page.locator('input[inputmode="numeric"]').fill("123456");
  await page
    .getByRole("button", { name: "Enter Admin Passkey" })
    .click();
  await page.waitForURL("**/admin");
  await expect(page.getByText("Telemetry Patient")).toBeVisible();

  // A second tab in the same admin context runs the EventSource. Its JS
  // context must outlive whatever navigation the other tab does to produce
  // the audit, so the stream and the trigger live on different pages.
  const monitor = await page.context().newPage();
  await monitor.goto("/admin");
  await expect(monitor.getByText("Telemetry Patient")).toBeVisible();

  const received = monitor.evaluate(async () => {
    const source = new EventSource("/api/admin/telemetry");

    try {
      // The route sends `ready` only after subscribing, so seeing it here
      // guarantees the listener below cannot miss subsequent events.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("telemetry stream never became ready")),
          10_000
        );
        source.addEventListener(
          "ready",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
        source.onerror = () => reject(new Error("telemetry stream failed"));
      });

      const event = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for an audit.entry event")),
            15_000
          );

          source.addEventListener("audit.entry", (event) => {
            clearTimeout(timeout);
            resolve(JSON.parse((event as MessageEvent).data));
          });
          source.onerror = () => reject(new Error("telemetry stream failed"));
        }
      );

      return event;
    } finally {
      source.close();
    }
  });

  // Cancel the seeded appointment from the dashboard: the server action
  // writes an `appointment.update` ledger entry, which the stream surfaces.
  // Using a real action (not a reload) guarantees the audit happens *after*
  // the listener is attached, because server actions always execute.
  await page.getByRole("button", { name: "cancel", exact: true }).click();
  await page.getByPlaceholder("Urgent meeting came up").fill("Doctor is away");
  await page
    .getByRole("button", { name: "Cancel Appointment" })
    .click();

  await expect(
    page.getByText("cancelled", { exact: true })
  ).toBeVisible();

  const entry = await received;

  expect(entry).toMatchObject({
    seq: expect.any(Number),
    action: "appointment.update",
    resourceType: "appointment",
    actorRole: "admin",
  });
  expect(entry.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("rejects a non-admin request for the telemetry stream", async ({
  request,
}) => {
  const response = await request.get("/api/admin/telemetry");

  expect(response.status()).toBe(401);
});