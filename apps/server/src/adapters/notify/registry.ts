import type { NotificationAgent as AgentId } from '@hearer/shared';
import { discordAgent } from './discord.ts';
import { ntfyAgent } from './ntfy.ts';
import { slackAgent } from './slack.ts';
import { smtpAgent } from './smtp.ts';
import { erase, type ErasedAgent } from './types.ts';
import { webhookAgent } from './webhook.ts';

const AGENTS: readonly ErasedAgent[] = [
  erase(webhookAgent),
  erase(discordAgent),
  erase(slackAgent),
  erase(ntfyAgent),
  erase(smtpAgent),
];

/** The notification agents, in the order the settings UI lists them. */
export function listAgents(): readonly ErasedAgent[] {
  return AGENTS;
}

export function getAgent(id: AgentId): ErasedAgent {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`unknown notification agent: ${id}`);
  return agent;
}
