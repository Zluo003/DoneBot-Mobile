// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.
export interface DefaultBotMark {
  /** Team Cloud only: the lowercased email of the member this DoneBot belongs to. Absent: the place's own. */
  person?: string;
}

export interface DefaultBotFields {
  /** This bot is its place's (or, on a Team Cloud, its member's) DoneBot. Never deleted or archived. */
  defaultBot?: DefaultBotMark;
  /** Settings → General "Show DoneBot in the sidebar" is off: the bot keeps working, only its sidebar row is gone. */
  sidebarHidden?: boolean;
  /** Its person has seen DoneBot's first-launch welcome here and chose Add or Not now. */
  welcomed?: boolean;
}

export const defaultBotPerson = (bot: DefaultBotFields): string => bot.defaultBot?.person?.trim().toLowerCase() ?? "";

/** The DoneBot a viewer sees as theirs: their own on a Team Cloud (by email), else the place's. */
export function viewersDefaultBot<T extends DefaultBotFields>(bots: readonly T[], email?: string | null): T | undefined {
  const person = email?.trim().toLowerCase() ?? "";
  return (person ? bots.find((bot) => bot.defaultBot && defaultBotPerson(bot) === person) : undefined)
    ?? bots.find((bot) => bot.defaultBot && !defaultBotPerson(bot));
}
