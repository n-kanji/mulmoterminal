import { DEFAULT_COPY_ON_SELECT, sanitizeCopyOnSelect } from "../../common/copyOnSelect";

// Whether a finished selection drag lands on the system clipboard, hydrated once from
// /api/config and read by the terminal manager at selection time. A plain module value,
// not a ref: nothing renders it, one setting applies to every open terminal at once, and
// keeping it free of xterm imports lets useAppConfig set it without pulling the terminal
// manager into the config layer (same shape as terminalSubmitMode).
let enabled: boolean = DEFAULT_COPY_ON_SELECT;

export const getCopyOnSelect = (): boolean => enabled;
// Takes the RAW config value, so a server that predates the field (undefined) resolves to
// the same default here as it does on disk — the one rule lives in common/copyOnSelect.
export const setCopyOnSelect = (input: unknown): void => {
  enabled = sanitizeCopyOnSelect(input);
};
