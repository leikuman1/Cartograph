import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { getEnvironment } from "./lib/env";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/__clerk(.*)",
]);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Validate here as well as at startup so a bad key fails with our message.
  getEnvironment();
  return clerkMiddleware(
    async (auth, workspaceRequest) => {
      if (!isPublicRoute(workspaceRequest)) {
        await auth.protect();
      }
    },
    {
      // Clerk reads both keys from the environment. Passing secretKey here marks
      // it as propagated request data, which Clerk encrypts and therefore needs
      // CLERK_ENCRYPTION_KEY for. Nothing here propagates a dynamic key.
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
