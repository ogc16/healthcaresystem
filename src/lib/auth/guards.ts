import { cookies } from "next/headers";

import { ADMIN_SESSION_COOKIE, isValidAdminSessionToken } from "./session";

export const isAdminSession = async () => {
  const store = await cookies();

  return isValidAdminSessionToken(store.get(ADMIN_SESSION_COOKIE)?.value);
};