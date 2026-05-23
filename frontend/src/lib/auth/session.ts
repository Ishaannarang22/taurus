import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

/**
 * Returns the currently authenticated user, or null if not signed in.
 * Server-only. Safe to call from Server Components, Server Actions, Route Handlers.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Returns the currently authenticated user.
 * Redirects to /login if not signed in.
 * Use in Server Components / Server Actions that require auth.
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
