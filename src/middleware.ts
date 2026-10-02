import { NextResponse, type NextRequest } from "next/server";

import {
  ADMIN_SESSION_COOKIE,
  isValidAdminSessionToken,
  isValidPatientSessionToken,
  PATIENT_SESSION_COOKIE,
} from "@/lib/auth/session";

export const middleware = async (request: NextRequest) => {
  const { pathname } = request.nextUrl;
  const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");

  const valid = isAdminRoute
    ? await isValidAdminSessionToken(
        request.cookies.get(ADMIN_SESSION_COOKIE)?.value
      )
    : await isValidPatientSessionToken(
        request.cookies.get(PATIENT_SESSION_COOKIE)?.value
      );

  if (valid) return NextResponse.next();

  const loginUrl = new URL(isAdminRoute ? "/admin/login" : "/login", request.url);

  loginUrl.searchParams.set("from", pathname);

  return NextResponse.redirect(loginUrl);
};

export const config = {
  matcher: ["/admin", "/admin/((?!login).*)", "/patients/:path*"],
};
