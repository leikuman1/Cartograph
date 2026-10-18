import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getEnvironment } from "./lib/env";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/__clerk(.*)",
]);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  if (pathname === "/preview" || pathname.startsWith("/preview/")) {
    return NextResponse.next();
  }

  const { clerkPublishableKey, clerkSecretKey } = getEnvironment();
  return clerkMiddleware(
    async (auth, workspaceRequest) => {
      if (!isPublicRoute(workspaceRequest)) {
        await auth.protect();
      }
    },
    {
      publishableKey: clerkPublishableKey,
      secretKey: clerkSecretKey,
      signInUrl: "/sign-in",
      signUpUrl: "/sign-up",
    },
  )(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
