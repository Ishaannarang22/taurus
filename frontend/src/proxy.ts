import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Proxy (Next.js 16 name for Middleware).
 *
 * Two responsibilities:
 *   1. Refresh the Supabase session on every request so cookies stay fresh.
 *   2. Gate app routes: unauthenticated requests to protected paths redirect to /login.
 *
 * Public paths (no auth required): /login, /signup, and /api/cron/*.
 * Static assets are excluded via the `matcher` config below.
 */
export async function proxy(request: NextRequest) {
  // Build a mutable response so @supabase/ssr can set refreshed session cookies.
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write updated cookies onto the request first (for downstream handlers),
          // then onto the response (so the browser receives them).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh session — must be called before any redirect logic.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Paths that are always public.
  const isPublic =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname.startsWith("/api/cron");

  // Unauthenticated user hitting a protected route → send to login.
  if (!isPublic && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve the original destination so we can redirect back after login (future).
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated user hitting a plain auth page → send to dashboard.
  if ((pathname === "/login" || pathname === "/signup") && user) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    dashboardUrl.search = "";
    return NextResponse.redirect(dashboardUrl);
  }

  return response;
}

/**
 * Run this proxy on every route except:
 *   - Next.js internals (_next/static, _next/image)
 *   - Common static file extensions
 *   - favicon
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot)$).*)",
  ],
};
