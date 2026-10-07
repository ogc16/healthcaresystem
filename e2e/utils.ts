const MOCK_URL = "http://localhost:7800/v1";

export type SeedUser = {
  name: string;
  email: string;
  phone: string;
  password: string;
};

export type SeedPayload = {
  user: SeedUser;
  patient?: Record<string, unknown>;
  appointment?: Record<string, unknown>;
};

const request = async (path: string, options?: RequestInit) => {
  const response = await fetch(`${MOCK_URL}${path}`, options);

  if (!response.ok) {
    throw new Error(`mock request ${path} failed: ${response.status}`);
  }

  return response.json();
};

export const resetMock = async () => {
  await request("/__reset", { method: "POST" });
};

export const seedMock = async (payload: SeedPayload) => {
  await request("/__seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
};

export const fetchMessages = async (): Promise<
  { $id: string; message: string; users: string[] }[]
> => {
  const { messages } = await request("/__messages");

  return messages;
};