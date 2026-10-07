import { expect, test } from "@playwright/test";

import { resetMock, seedMock } from "./utils";

test("a patient books an appointment and an admin schedules it", async ({
  page,
  browser,
}) => {
  await resetMock();
  await seedMock({
    user: {
      name: "Bella Booker",
      email: "bella@example.com",
      phone: "+1555100200",
      password: "bella-password",
    },
    patient: {
      name: "Bella Booker",
      email: "bella@example.com",
      phone: "+1555100200",
    },
  });

  // Patient signs in
  await page.goto("/login");
  await page.getByPlaceholder("johndoe@gmail.com").fill("bella@example.com");
  await page
    .getByPlaceholder("••••••••")
    .fill("bella-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/patients/new-appointment");
  await expect(
    page.getByRole("heading", { name: "New Appointment" })
  ).toBeVisible();

  await page.getByText("Select a doctor").click();
  await page.getByRole("option", { name: /Leila Cameron/ }).click();
  await page
    .getByPlaceholder("Annual montly check-up")
    .fill("Annual physical");
  await page
    .getByPlaceholder("Prefer afternoon appointments, if possible")
    .fill("Afternoon preferred");
  await page.getByRole("button", { name: "Submit Apppointment" }).click();

  await page.waitForURL("**/patients/new-appointment/success?appointmentId=*");
  await expect(
    page.getByText("has been successfully submitted!")
  ).toBeVisible();

  // Admin signs in and schedules the request
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();

  await adminPage.goto("/admin");
  await adminPage.waitForURL(/\/admin\/login/);
  await adminPage.locator('input[inputmode="numeric"]').fill("123456");
  await adminPage
    .getByRole("button", { name: "Enter Admin Passkey" })
    .click();
  await adminPage.waitForURL("**/admin");

  await expect(adminPage.getByText("Bella Booker")).toBeVisible();

  await adminPage
    .getByRole("button", { name: "schedule", exact: true })
    .click();
  await adminPage
    .getByRole("button", { name: "Schedule Appointment" })
    .click();

  await expect(adminPage.getByText("scheduled", { exact: true })).toBeVisible();

  await adminContext.close();
});