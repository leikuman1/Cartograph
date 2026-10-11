import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignInPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <Suspense fallback={<p role="status" className="text-sm">Loading sign in…</p>}>
        <SignIn routing="path" path="/sign-in" />
      </Suspense>
    </div>
  );
}
