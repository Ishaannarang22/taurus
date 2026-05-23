import type { Metadata } from "next";
import { NewStrategyForm } from "./new-strategy-form";

export const metadata: Metadata = {
  title: "New Strategy — Taurus",
};

interface PageProps {
  searchParams: Promise<{ prompt?: string }>;
}

// Thin server shell — reads the optional ?prompt= pre-fill from the URL,
// then hands off to the client form component.
export default async function NewStrategyPage({ searchParams }: PageProps) {
  const { prompt: initialPrompt } = await searchParams;
  return <NewStrategyForm initialPrompt={initialPrompt ?? ""} />;
}
