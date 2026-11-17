/** Thinking levels of Pi. Kept apart from session.ts so browser code can import them without zod. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
