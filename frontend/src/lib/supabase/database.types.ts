export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_memories: {
        Row: {
          category: string | null
          content: string
          created_at: string
          created_by_run_id: string | null
          id: string
          user_id: string
        }
        Insert: {
          category?: string | null
          content: string
          created_at?: string
          created_by_run_id?: string | null
          id?: string
          user_id: string
        }
        Update: {
          category?: string | null
          content?: string
          created_at?: string
          created_by_run_id?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_memories_created_by_run_id_fkey"
            columns: ["created_by_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json | null
          kind: string | null
          model: string | null
          output: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["agent_run_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          kind?: string | null
          model?: string | null
          output?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          kind?: string | null
          model?: string | null
          output?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["agent_run_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      backtests: {
        Row: {
          code_snapshot: string | null
          created_at: string
          end_date: string | null
          id: string
          params_snapshot: Json
          results: Json | null
          start_date: string | null
          status: Database["public"]["Enums"]["backtest_status"]
          strategy_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          code_snapshot?: string | null
          created_at?: string
          end_date?: string | null
          id?: string
          params_snapshot?: Json
          results?: Json | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["backtest_status"]
          strategy_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          code_snapshot?: string | null
          created_at?: string
          end_date?: string | null
          id?: string
          params_snapshot?: Json
          results?: Json | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["backtest_status"]
          strategy_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtests_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_connections: {
        Row: {
          broker: string
          created_at: string
          credentials_secret_id: string | null
          environment: Database["public"]["Enums"]["broker_environment"]
          id: string
          label: string | null
          status: Database["public"]["Enums"]["broker_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          broker: string
          created_at?: string
          credentials_secret_id?: string | null
          environment?: Database["public"]["Enums"]["broker_environment"]
          id?: string
          label?: string | null
          status?: Database["public"]["Enums"]["broker_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          broker?: string
          created_at?: string
          credentials_secret_id?: string | null
          environment?: Database["public"]["Enums"]["broker_environment"]
          id?: string
          label?: string | null
          status?: Database["public"]["Enums"]["broker_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      instruments: {
        Row: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          created_at: string
          currency: string
          exchange: string | null
          id: string
          name: string | null
          symbol: string
        }
        Insert: {
          asset_type?: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          currency?: string
          exchange?: string | null
          id?: string
          name?: string | null
          symbol: string
        }
        Update: {
          asset_type?: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          currency?: string
          exchange?: string | null
          id?: string
          name?: string | null
          symbol?: string
        }
        Relationships: []
      }
      investor_profiles: {
        Row: {
          created_at: string
          experience_level: string | null
          goals: string | null
          investable_capital: number | null
          preferences: Json
          risk_tolerance: string | null
          time_horizon: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          experience_level?: string | null
          goals?: string | null
          investable_capital?: number | null
          preferences?: Json
          risk_tolerance?: string | null
          time_horizon?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          experience_level?: string | null
          goals?: string | null
          investable_capital?: number | null
          preferences?: Json
          risk_tolerance?: string | null
          time_horizon?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          broker_connection_id: string | null
          broker_order_id: string | null
          created_at: string
          created_by_run_id: string | null
          filled_at: string | null
          id: string
          instrument_id: string
          limit_price: number | null
          mode: Database["public"]["Enums"]["trade_mode"]
          order_type: Database["public"]["Enums"]["order_type"]
          paper_account_id: string | null
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          status: Database["public"]["Enums"]["order_status"]
          strategy_id: string | null
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          broker_connection_id?: string | null
          broker_order_id?: string | null
          created_at?: string
          created_by_run_id?: string | null
          filled_at?: string | null
          id?: string
          instrument_id: string
          limit_price?: number | null
          mode?: Database["public"]["Enums"]["trade_mode"]
          order_type?: Database["public"]["Enums"]["order_type"]
          paper_account_id?: string | null
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          strategy_id?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          broker_connection_id?: string | null
          broker_order_id?: string | null
          created_at?: string
          created_by_run_id?: string | null
          filled_at?: string | null
          id?: string
          instrument_id?: string
          limit_price?: number | null
          mode?: Database["public"]["Enums"]["trade_mode"]
          order_type?: Database["public"]["Enums"]["order_type"]
          paper_account_id?: string | null
          quantity?: number
          side?: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          strategy_id?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_broker_connection_id_fkey"
            columns: ["broker_connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_created_by_run_id_fkey"
            columns: ["created_by_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_paper_account_id_fkey"
            columns: ["paper_account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_accounts: {
        Row: {
          cash_balance: number
          created_at: string
          id: string
          name: string
          starting_cash: number
          updated_at: string
          user_id: string
        }
        Insert: {
          cash_balance?: number
          created_at?: string
          id?: string
          name?: string
          starting_cash?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          cash_balance?: number
          created_at?: string
          id?: string
          name?: string
          starting_cash?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          avg_entry_price: number | null
          broker_connection_id: string | null
          created_at: string
          id: string
          instrument_id: string
          mode: Database["public"]["Enums"]["trade_mode"]
          paper_account_id: string | null
          quantity: number
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_entry_price?: number | null
          broker_connection_id?: string | null
          created_at?: string
          id?: string
          instrument_id: string
          mode?: Database["public"]["Enums"]["trade_mode"]
          paper_account_id?: string | null
          quantity?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          avg_entry_price?: number | null
          broker_connection_id?: string | null
          created_at?: string
          id?: string
          instrument_id?: string
          mode?: Database["public"]["Enums"]["trade_mode"]
          paper_account_id?: string | null
          quantity?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_broker_connection_id_fkey"
            columns: ["broker_connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_paper_account_id_fkey"
            columns: ["paper_account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          code: string | null
          created_at: string
          created_by_run_id: string | null
          description: string | null
          id: string
          name: string
          parameters: Json
          status: Database["public"]["Enums"]["strategy_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          created_by_run_id?: string | null
          description?: string | null
          id?: string
          name: string
          parameters?: Json
          status?: Database["public"]["Enums"]["strategy_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          created_by_run_id?: string | null
          description?: string | null
          id?: string
          name?: string
          parameters?: Json
          status?: Database["public"]["Enums"]["strategy_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategies_created_by_run_id_fkey"
            columns: ["created_by_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_legs: {
        Row: {
          created_at: string
          entry_price: number | null
          id: string
          instrument_id: string
          side: Database["public"]["Enums"]["order_side"]
          strategy_id: string
          target_weight: number
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_price?: number | null
          id?: string
          instrument_id: string
          side?: Database["public"]["Enums"]["order_side"]
          strategy_id: string
          target_weight: number
          user_id: string
        }
        Update: {
          created_at?: string
          entry_price?: number | null
          id?: string
          instrument_id?: string
          side?: Database["public"]["Enums"]["order_side"]
          strategy_id?: string
          target_weight?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_legs_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategy_legs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          backtest_id: string | null
          created_at: string
          executed_at: string
          fees: number
          id: string
          instrument_id: string
          order_id: string | null
          paper_account_id: string | null
          price: number
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          source: Database["public"]["Enums"]["execution_source"]
          strategy_id: string | null
          user_id: string
        }
        Insert: {
          backtest_id?: string | null
          created_at?: string
          executed_at?: string
          fees?: number
          id?: string
          instrument_id: string
          order_id?: string | null
          paper_account_id?: string | null
          price: number
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          source: Database["public"]["Enums"]["execution_source"]
          strategy_id?: string | null
          user_id: string
        }
        Update: {
          backtest_id?: string | null
          created_at?: string
          executed_at?: string
          fees?: number
          id?: string
          instrument_id?: string
          order_id?: string | null
          paper_account_id?: string | null
          price?: number
          quantity?: number
          side?: Database["public"]["Enums"]["order_side"]
          source?: Database["public"]["Enums"]["execution_source"]
          strategy_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_backtest_id_fkey"
            columns: ["backtest_id"]
            isOneToOne: false
            referencedRelation: "backtests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "instruments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_paper_account_id_fkey"
            columns: ["paper_account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      agent_run_status: "queued" | "running" | "completed" | "failed"
      asset_type: "stock" | "etf"
      backtest_status: "queued" | "running" | "completed" | "failed"
      broker_environment: "paper" | "live"
      broker_status: "active" | "disabled" | "error"
      execution_source: "live" | "paper" | "backtest"
      order_side: "buy" | "sell"
      order_status:
        | "pending"
        | "submitted"
        | "partially_filled"
        | "filled"
        | "cancelled"
        | "rejected"
      order_type: "market" | "limit" | "stop" | "stop_limit"
      strategy_status: "draft" | "active" | "archived"
      trade_mode: "paper" | "live"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_run_status: ["queued", "running", "completed", "failed"],
      asset_type: ["stock", "etf"],
      backtest_status: ["queued", "running", "completed", "failed"],
      broker_environment: ["paper", "live"],
      broker_status: ["active", "disabled", "error"],
      execution_source: ["live", "paper", "backtest"],
      order_side: ["buy", "sell"],
      order_status: [
        "pending",
        "submitted",
        "partially_filled",
        "filled",
        "cancelled",
        "rejected",
      ],
      order_type: ["market", "limit", "stop", "stop_limit"],
      strategy_status: ["draft", "active", "archived"],
      trade_mode: ["paper", "live"],
    },
  },
} as const
