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
  // Key by the incoming prompt so navigating here with a different ?prompt=
  // (e.g. a suggestion chip) remounts the form with fresh initial state,
  // avoiding a setState-in-effect to sync the prop.
  const prompt = initialPrompt ?? "";
  return <NewStrategyForm key={prompt} initialPrompt={prompt} />;
}
