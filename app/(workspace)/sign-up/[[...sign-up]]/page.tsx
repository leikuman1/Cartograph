import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignUpPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <Suspense fallback={<p role="status" className="text-sm">Loading sign up…</p>}>
        <SignUp routing="path" path="/sign-up" />
      </Suspense>
    </div>
  );
}
