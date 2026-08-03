export interface BrainbookStatus {
  configured: boolean;
  signed_in: boolean;
  email: string | null;
  sync_enabled: boolean;
  last_sync_at: number | null;
  pending_count: number;
}

export interface BrainbookSignInRequest {
  email: string;
  password: string;
}
