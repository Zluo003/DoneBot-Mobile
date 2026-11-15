import { z } from "zod";
import { idSchema, type WorkspaceConnection } from "./contracts";

export const automationSchema = z.object({
  id: idSchema, name: z.string(), botId: idSchema, enabled: z.boolean(),
  prompt: z.string().default(""), nextRunAt: z.number().nullable().optional(),
  checkTrouble: z.string().optional(), warning: z.string().optional(),
  appName: z.string().optional(), eventName: z.string().optional(),
});
export type AutomationKind = "schedule" | "webhook" | "app";
export type Automation = z.infer<typeof automationSchema> & { kind: AutomationKind };
export const automationPath = (kind: AutomationKind): string => kind === "schedule" ? "routines" : kind === "webhook" ? "webhooks" : "app-triggers";
export const automationKey = (workspaceId: string, item: Automation): string => `${workspaceId}/${item.kind}/${item.id}`;

export async function readAutomations(connection: WorkspaceConnection): Promise<Automation[]> {
  const [schedules, webhooks, apps] = await Promise.all([
    connection.request("/api/routines").then(reply => z.object({ routines: z.array(automationSchema) }).parse(reply)),
    connection.request("/api/webhooks").then(reply => z.object({ webhooks: z.array(automationSchema) }).parse(reply)),
    connection.request("/api/app-triggers").then(reply => z.object({ triggers: z.array(automationSchema) }).parse(reply)),
  ]);
  return [
    ...schedules.routines.map(item => ({ ...item, kind: "schedule" as const })),
    ...webhooks.webhooks.map(item => ({ ...item, kind: "webhook" as const })),
    ...apps.triggers.map(item => ({ ...item, kind: "app" as const })),
  ];
}

export const connectedAppsSchema = z.object({
  credentialStore: z.string().optional(), inventoryComplete: z.boolean().optional(),
  services: z.record(z.string(), z.object({
    connected: z.boolean(), pending: z.boolean().optional(), status: z.string().optional(),
    accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })).optional(),
  })),
});
export type ConnectedApp = z.infer<typeof connectedAppsSchema>["services"][string] & { id: string };
