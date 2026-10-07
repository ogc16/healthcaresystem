import { expect, test } from "@playwright/test";

import { drainSmsOutbox, fetchMessages, resetMock, seedMock } from "./utils";

const schedule = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

test("an admin cancels an appointment and the patient is notified", async ({
  page,
  browser,
}) => {
  await resetMock();
  await seedMock({
    user: {
      name: "Carl Cancel",
      email: "carl@example.com",
      phone: "+1555100300",
      password: "carl-password",
    },
    patient: {
      name: "Carl Cancel",
      email: "carl@example.com",
      phone: "+1555100300",
    },
    appointment: {
      primaryPhysician: "Evan Peter",
      schedule,
      reason: "Flu symptoms",
      status: "pending",
      note: "",
    },
  });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();

  await adminPage.goto("/admin");
  await adminPage.waitForURL(/\/admin\/login/);
  await adminPage.locator('input[inputmode="numeric"]').fill("123456");
  await adminPage
    .getByRole("button", { name: "Enter Admin Passkey" })
    .click();
  await adminPage.waitForURL("**/admin");

  await expect(adminPage.getByText("Carl Cancel")).toBeVisible();
  await expect(adminPage.getByText("Pending").first()).toBeVisible();

  // Cancel from the row action
  await adminPage
    .getByRole("button", { name: "cancel", exact: true })
    .click();
  await adminPage
    .getByPlaceholder("Urgent meeting came up")
    .fill("Doctor is away");
  await adminPage
    .getByRole("button", { name: "Cancel Appointment" })
    .click();

  await expect(adminPage.getByText("cancelled", { exact: true })).toBeVisible();

  // The update action only writes to the SMS outbox; delivery is the cron's
  // job. Drain it here so the assertion exercises the full queue path.
  const drained = await drainSmsOutbox();
  expect(drained.ok).toBe(true);

  // The update action queues an SMS to the record's owner, not the caller.
  const messages = await fetchMessages();
  const sms = messages[messages.length - 1];

  expect(sms).toBeDefined();
  expect(sms.message).toContain("cancelled");

  await adminContext.close();
});