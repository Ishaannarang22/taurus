import { redirect } from "next/navigation";

// Root route — auth gating is handled by Agent A's middleware.
// Any authenticated visitor is sent straight to the dashboard.
export default function RootPage() {
  redirect("/dashboard");
}
