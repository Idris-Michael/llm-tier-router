export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Token counts in one shape for every provider. `prompt` includes `cached`. */
export interface Usage {
  prompt: number;
  cached: number;
  completion: number;
}

export interface Completion {
  text: string;
  usage: Usage;
  /** The model id that actually answered, with its provider prefix. */
  model: string;
}

/** Model per tier. Complexity 1–2 → cheap, 3 → mid, 4–5 → frontier. */
export interface Tiers {
  cheap: string;
  mid: string;
  frontier: string;
}
