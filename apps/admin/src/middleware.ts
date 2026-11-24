import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Fast cookie presence check only; every page, route and action re-validates the session server-side.
// API requests without a session get a 401 JSON body; pages are redirected to /login.
export function middleware(request: NextRequest) {
  if (!getSessionCookie(request)) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico|kalpix-mark.svg).*)"],
};
