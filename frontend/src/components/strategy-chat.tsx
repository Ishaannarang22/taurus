import type { StrategyDetailView } from "@/lib/data/types";
import styles from "./strategy-chat.module.css";

interface Props {
  strategy: StrategyDetailView;
}

export function StrategyChat({ strategy }: Props) {
  return (
    <div className={styles.chatLog}>
      <div className={`${styles.msg} ${styles.you}`}>
        <div className={styles.role}>You</div>
        <div className={styles.body}>{strategy.prompt ?? strategy.description ?? strategy.name}</div>
      </div>
      <div className={`${styles.msg} ${styles.taurus}`}>
        <div className={styles.role}>Taurus</div>
        <div className={styles.body}>{strategy.description}</div>
      </div>
    </div>
  );
}
