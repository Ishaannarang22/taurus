"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn } from "@/lib/auth/actions";
import styles from "../auth.module.css";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, undefined);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {/* Brand */}
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <BullIcon />
          </span>
          <span className={styles.brandName}>Taurus</span>
        </div>

        <h1 className={styles.heading}>Sign in</h1>
        <p className={styles.subheading}>
          Enter your credentials to access your portfolio.
        </p>

        <form className={styles.form} action={action}>
          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              className={styles.input}
            />
          </div>

          {state?.error && (
            <p className={styles.error} role="alert">
              {state.error}
            </p>
          )}

          <div className={styles.submitRow}>
            <button type="submit" disabled={pending} className={styles.submit}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>

        <p className={styles.footer}>
          No account?{" "}
          <Link href="/signup" className={styles.footerLink}>
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

function BullIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6c1.5 0 3 .8 3.5 2.2" />
      <path d="M21 6c-1.5 0-3 .8-3.5 2.2" />
      <path d="M6.5 8.2c1.2 2.4 3 4 5.5 4s4.3-1.6 5.5-4" />
      <path d="M7 12.5c.4 3 2.4 6 5 6s4.6-3 5-6" />
      <circle cx="9.5" cy="11" r="0.6" fill="currentColor" />
      <circle cx="14.5" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}
