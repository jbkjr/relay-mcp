// Internal snapshot carried through result spreads, but omitted by JSON.stringify. Naming an
// item is not evidence that a result reports its completion (pending handles and run listings).
export const REPORTED_COMPLETION = Symbol("reported completion");
export interface ReportedCompletion { id: string; status: string; endedAt: number | null }
