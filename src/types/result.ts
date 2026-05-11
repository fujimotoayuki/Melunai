export type ToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        cause?: unknown;
      };
    };
