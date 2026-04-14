import type { ApiResponse } from '../models/api-response.js';
import { emit } from '../formatters/output.js';
import * as loginCmd from './commands/login.js';
import * as logoutCmd from './commands/logout.js';

export interface GlobalFlags {
  json: boolean;
  help: boolean;
}

export type CommandFlags = Record<string, unknown>;

export interface Command {
  description: string;
  help: string;
  execute(flags: CommandFlags, global: GlobalFlags): Promise<void>;
}

function wrap<T, F>(
  description: string,
  help: string,
  run: (flags: F) => Promise<ApiResponse<T>>,
  render: (data: T) => string
): Command {
  return {
    description,
    help,
    async execute(flags, _global) {
      const response = await run(flags as unknown as F);
      emit(response, render);
    },
  };
}

export const registry: Record<string, Record<string, Command>> = {
  login: {
    _: wrap<loginCmd.LoginData, loginCmd.LoginFlags>(
      'Authorize with Google Drive',
      loginCmd.HELP,
      loginCmd.run,
      loginCmd.render
    ),
  },
  logout: {
    _: wrap<logoutCmd.LogoutData, unknown>(
      'Clear stored credentials',
      logoutCmd.HELP,
      () => logoutCmd.run(),
      logoutCmd.render
    ),
  },
};
