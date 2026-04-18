import { emit } from '../formatters/output.js';
import type { ApiResponse } from '../models/api-response.js';
import * as configAddRootCmd from './commands/config-add-root.js';
import * as configListRootsCmd from './commands/config-list-roots.js';
import * as configRemoveRootCmd from './commands/config-remove-root.js';
import * as configShowCmd from './commands/config-show.js';
import * as downloadCmd from './commands/download.js';
import * as indexCmd from './commands/index.js';
import * as listCmd from './commands/list.js';
import * as loginCmd from './commands/login.js';
import * as logoutCmd from './commands/logout.js';
import * as ollamaSetupCmd from './commands/ollama-setup.js';
import * as searchCmd from './commands/search.js';
import * as showCmd from './commands/show.js';

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
  index: {
    _: wrap<indexCmd.IndexData, indexCmd.IndexFlags>(
      'Build or refresh the persistent Drive graph',
      indexCmd.HELP,
      indexCmd.run,
      indexCmd.render
    ),
  },
  config: {
    show: wrap<configShowCmd.ConfigShowData, configShowCmd.ConfigShowFlags>(
      'Print the workspace config',
      configShowCmd.HELP,
      configShowCmd.run,
      configShowCmd.render
    ),
    'list-roots': wrap<
      configListRootsCmd.ConfigListRootsData,
      configListRootsCmd.ConfigListRootsFlags
    >(
      'List configured root folders',
      configListRootsCmd.HELP,
      configListRootsCmd.run,
      configListRootsCmd.render
    ),
    'add-root': wrap<
      configAddRootCmd.ConfigAddRootData,
      configAddRootCmd.ConfigAddRootFlags
    >(
      'Persist a Drive folder as a root',
      configAddRootCmd.HELP,
      configAddRootCmd.run,
      configAddRootCmd.render
    ),
    'remove-root': wrap<
      configRemoveRootCmd.ConfigRemoveRootData,
      configRemoveRootCmd.ConfigRemoveRootFlags
    >(
      'Remove a configured root',
      configRemoveRootCmd.HELP,
      configRemoveRootCmd.run,
      configRemoveRootCmd.render
    ),
  },
  ollama: {
    setup: wrap<
      ollamaSetupCmd.OllamaSetupData,
      ollamaSetupCmd.OllamaSetupFlags
    >(
      'Configure local Ollama for gdrivescope',
      ollamaSetupCmd.HELP,
      ollamaSetupCmd.run,
      ollamaSetupCmd.render
    ),
  },
  list: {
    _: wrap<listCmd.ListData, listCmd.ListFlags>(
      'List entries under a folder from the indexed graph',
      listCmd.HELP,
      listCmd.run,
      listCmd.render
    ),
  },
  show: {
    _: wrap<showCmd.ShowData, showCmd.ShowFlags>(
      'Show a single node from the indexed graph',
      showCmd.HELP,
      showCmd.run,
      showCmd.render
    ),
  },
  search: {
    _: wrap<searchCmd.SearchData, searchCmd.SearchFlags>(
      'Search the indexed graph by name or embedding',
      searchCmd.HELP,
      searchCmd.run,
      searchCmd.render
    ),
  },
  download: {
    _: wrap<downloadCmd.DownloadData, downloadCmd.DownloadFlags>(
      'Download a file from Drive',
      downloadCmd.HELP,
      downloadCmd.run,
      downloadCmd.render
    ),
  },
};
