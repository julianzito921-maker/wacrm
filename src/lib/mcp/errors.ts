export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'forbidden'
      | 'not_found'
      | 'invalid_input'
      | 'validation'
      | 'send_failed'
      | 'internal' = 'internal',
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}
