export const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const errorResult = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: message }],
});
