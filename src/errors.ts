export function safeError(error: unknown): string {
    return error instanceof Error ? error.message.replace(/(?:Bearer\s+|gh[pousr]_)[\w.-]+/gi, '[redacted]').slice(0, 500) : 'Unexpected failure';
}
