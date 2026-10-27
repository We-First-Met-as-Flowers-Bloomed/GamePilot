export function runGameMode(
  args: string[],
  options?: {
    read?: (file: string) => string;
    write?: (file: string, body: string) => unknown;
    mkdir?: (directory: string, options: { recursive: boolean }) => unknown;
    request?: (...args: any[]) => Promise<any>;
    run?: (...args: any[]) => Promise<any>;
    log?: (value: any) => void;
    root?: string;
    now?: Date;
  },
): Promise<number>;
