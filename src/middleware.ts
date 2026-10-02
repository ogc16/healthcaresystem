import { NextResponse, type NextRequest } from "next/server";

import {
  ADMIN_SESSION_COOKIE,
  isValidAdminSessionToken,
} from "@/lib/auth/session";

export const middleware = async (request: NextRequest) => {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;

  if (await isValidAdminSessionToken(token)) return NextResponse.next();

  const loginUrl = new URL("/admin/login", request.url);

  loginUrl.searchParams.set("from", request.nextUrl.pathname);

  return NextResponse.redirect(loginUrl);
};

export const config = {
  matcher: ["/admin", "/admin/((?!login).*)"],
};