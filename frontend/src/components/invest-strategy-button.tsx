"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  investStrategyAction,
  type InvestStrategyState,
} from "@/app/actions/strategy";
import { ArrowIcon } from "@/components/icons";
import styles from "./invest-strategy-button.module.css";

interface Props {
  strategyId: string;
}

const initialState: InvestStrategyState = {};

export function InvestStrategyButton({ strategyId }: Props) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    investStrategyAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) {
      router.push("/orders");
    }
  }, [router, state.ok]);

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="strategyId" value={strategyId} />
      <button type="submit" className={styles.button} disabled={isPending}>
        {isPending ? "Investing..." : "Invest basket"}
        <ArrowIcon />
      </button>
      {state.error && <span className={styles.error}>{state.error}</span>}
    </form>
  );
}
