// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.
export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: ConnectorAccount[];
}

export interface ConnectorAccount {
  id: string;
  alias?: string;
  status: string;
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

const ACTIVE = /^active$/i;
const UNFINISHED = /^(initiated|initializing|pending)$/i;

/** An app counts as connected only through an ACTIVE account; with no account list (an app that needs no sign-in, or
 *  only the Session's answer) the server's flag stands. */
export function hasActiveConnection(state: ConnectorStatus | undefined): boolean {
  const accounts = state?.accounts ?? [];
  return accounts.length ? accounts.some((account) => ACTIVE.test(account.status)) : state?.connected === true;
}
