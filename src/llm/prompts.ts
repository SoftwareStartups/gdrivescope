export const SUMMARY_SYSTEM =
  "You are a document classifier and summarizer. Respond in English regardless of the document's source language. Classification must be exactly one of the allowed values.";

export const SUMMARY_USER_SNIPPET_CHARS = 3000;

export interface SummaryUserParams {
  filename: string;
  path: string;
  markdown: string;
}

export function summaryUser(params: SummaryUserParams): string {
  const snippet = params.markdown.slice(0, SUMMARY_USER_SNIPPET_CHARS);
  return `Filename: ${params.filename}\nPath: ${params.path}\n\nContent:\n${snippet}`;
}
