import path from "node:path";

import { expect, test } from "@playwright/test";

import { resetMock } from "./utils";

test("a new patient signs up, completes registration, and uploads an identification document", async ({
  page,
}) => {
  await resetMock();

  await page.goto("/");

  // Sign up
  await page.getByPlaceholder("John Doe").fill("Ada Example");
  await page.getByPlaceholder("johndoe@gmail.com").fill("ada@example.com");
  await page.getByPlaceholder("(555) 123-4567").fill("(555) 100-1000");
  await page
    .getByPlaceholder("At least 8 characters")
    .fill("super-secret-password-1");
  await page
    .getByPlaceholder("Repeat your password")
    .fill("super-secret-password-1");
  await page.getByRole("button", { name: "Get Started" }).click();

  await page.waitForURL("**/patients/register");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  // Personal information
  await page
    .getByPlaceholder("14 street, New york, NY - 5101")
    .fill("742 Evergreen Terrace");
  await page.getByPlaceholder(" Software Engineer").fill("Physicist");
  await page.getByPlaceholder("Guardian's name").fill("Grace Hopper");
  await page
    .getByPlaceholder("(555) 123-4567")
    .nth(1)
    .fill("(555) 200-2000");

  // Medical information
  await page.getByText("Select a physician").click();
  await page.getByRole("option", { name: /John Green/ }).click();
  await page.getByPlaceholder("BlueCross BlueShield").fill("Seabreeze Mutual");
  await page.getByPlaceholder("ABC123456789").fill("POL-0001");
  await page
    .getByPlaceholder("Peanuts, Penicillin, Pollen")
    .fill("None");
  await page
    .getByPlaceholder("Ibuprofen 200mg, Levothyroxine 50mcg")
    .fill("None");
  await page
    .getByPlaceholder("Mother had brain cancer, Father has hypertension")
    .fill("None");
  await page
    .getByPlaceholder("Appendectomy in 2015, Asthma diagnosis in childhood")
    .fill("None");

  // Identification and verification
  await page.getByPlaceholder("123456789", { exact: true }).fill("ID-0001");
  await page
    .setInputFiles(
      'input[type="file"]',
      path.join(__dirname, "fixtures", "id.png")
    );
  await expect(page.getByAltText("uploaded document")).toBeVisible();

  // Consent
  await page
    .locator("label.checkbox-label", { hasText: "I consent to receive" })
    .click();
  await page
    .locator("label.checkbox-label", { hasText: "disclosure of my health" })
    .click();
  await page
    .locator("label.checkbox-label", { hasText: "privacy policy" })
    .click();

  await page.getByRole("button", { name: "Submit and Continue" }).click();

  await page.waitForURL("**/patients/new-appointment");
  await expect(
    page.getByRole("heading", { name: "New Appointment" })
  ).toBeVisible();
});